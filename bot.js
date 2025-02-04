require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const express = require('express');

// Express 伺服器設定
const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`伺服器正在監聽端口 ${PORT}`));

// 初始化 Discord 客戶端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// 環境變數和常數
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MAX_HISTORY_LENGTH = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

// 添加連線維護相關常數
const HEARTBEAT_INTERVAL = 4 * 60 * 1000; // 4分鐘檢查一次
const RECONNECT_DELAY = 30000; // 30秒重試間隔
let heartbeatInterval;

// 添加連線狀態管理
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// 重設重連次數的計時器
setInterval(() => {
    reconnectAttempts = 0;
}, 3600000); // 每小時重設

// **城市名稱對應表**
const cityMapping = {
    "基隆": "Keelung",        // 北部
    "台北": "Taipei",
    "新北": "New Taipei",
    "桃園": "Taoyuan",
    "新竹": "Hsinchu",
    "宜蘭": "Yilan",
    "台中": "Taichung",      // 中部
    "苗栗": "Miaoli",
    "彰化": "Changhua",
    "南投": "Nantou",
    "雲林": "Yunlin",
    "嘉義": "Chiayi",        // 南部
    "台南": "Tainan",
    "高雄": "Kaohsiung",
    "屏東": "Pingtung",
    "台東": "Taitung",       // 東部
    "花蓮": "Hualien",
    "澎湖": "Penghu",        // 離島
    "金門": "Kinmen",
    "連江": "Lienchiang",
};

// 擴展 ConversationManager 類別，添加清理機制
class ConversationManager {
    constructor() {
        this.conversations = new Map();
        this.lastAccess = new Map();
        
        // 每6小時清理一次過期對話
        setInterval(() => this.cleanupOldConversations(), 6 * 60 * 60 * 1000);
    }

    getHistory(userId) {
        if (!this.conversations.has(userId)) {
            this.conversations.set(userId, [{
                role: 'system',
                content: '你是個專精於繁體中文的聊天助手。請以繁體中文回應所有訊息，並避免混用其他語言或字符。'
            }]);
        }
        this.lastAccess.set(userId, Date.now());
        return this.conversations.get(userId);
    }

    addMessage(userId, message) {
        const history = this.getHistory(userId);
        history.push(message);
        
        if (history.length > MAX_HISTORY_LENGTH) {
            history.splice(1, history.length - MAX_HISTORY_LENGTH);
        }
        this.lastAccess.set(userId, Date.now());
    }

    // 清理24小時未使用的對話
    cleanupOldConversations() {
        const now = Date.now();
        const expiryTime = 24 * 60 * 60 * 1000; // 24小時
        
        for (const [userId, lastAccess] of this.lastAccess.entries()) {
            if (now - lastAccess > expiryTime) {
                this.conversations.delete(userId);
                this.lastAccess.delete(userId);
            }
        }
    }
}

// 天氣服務類別
class WeatherService {
    static async getCurrentWeather(city) {
        const encodedCity = encodeURIComponent(cityMapping[city] || city);
        const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodedCity}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_tw`;
        const response = await axios.get(url);
        return response.data;
    }

    static async getForecast(city) {
        const encodedCity = encodeURIComponent(cityMapping[city] || city);
        const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodedCity}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_tw`;
        const response = await axios.get(url);
        return response.data;
    }

    static formatWeatherResponse(current, forecast) {
        const dailyForecasts = this.processForecast(forecast.list);
        const forecastMsg = this.formatForecastMessage(dailyForecasts);

        return `
📍 **${current.name}** 的天氣：
🌡 當前溫度: ${current.main.temp}°C
🌬 風速: ${current.wind.speed}m/s
☁ 天氣: ${current.weather[0].description}
🔮 **未來 3 天天氣預報：**
${forecastMsg}`;
    }

    static processForecast(forecastList) {
        const dailyForecasts = {};
        forecastList.forEach(item => {
            const date = item.dt_txt.split(' ')[0];
            if (!dailyForecasts[date]) {
                dailyForecasts[date] = item;
            }
        });
        return dailyForecasts;
    }

    static formatForecastMessage(dailyForecasts) {
        return Object.entries(dailyForecasts)
            .slice(0, 3)
            .map(([date, forecast]) => 
                `📅 **${date}**：${forecast.weather[0].description}，` +
                `🌡 溫度 ${forecast.main.temp}°C，` +
                `🌬 風速 ${forecast.wind.speed}m/s`)
            .join('\n');
    }
}

// 優化 ChatService 類別
class ChatService {
    static async getResponse(messages) {
        let attempts = 0;
        const maxRetries = MAX_RETRIES;
        
        while (attempts < maxRetries) {
            try {
                const response = await axios.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'llama3-70b-8192',
                        messages,
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${GROQ_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 30000, // 設置30秒超時
                    }
                );
                
                const reply = response.data.choices?.[0]?.message?.content;
                if (!reply?.trim()) {
                    throw new Error('收到空回應');
                }
                return reply;
            } catch (error) {
                attempts++;
                console.error(`API 嘗試 ${attempts}/${maxRetries} 失敗:`, error.message);
                
                if (attempts === maxRetries) throw error;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempts));
            }
        }
    }
}

// 心跳檢查函數
function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    
    heartbeatInterval = setInterval(() => {
        if (!client.ws.ping || !isConnected) {
            console.log('檢測到連線異常，準備重新連線...');
            reconnect();
        } else {
            console.log(`連線正常，延遲: ${client.ws.ping}ms`);
        }
    }, HEARTBEAT_INTERVAL);
}

// 重新連線函數
async function reconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('已達到最大重試次數，請檢查網路連線或手動重啟機器人');
        process.exit(1);
    }

    try {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        
        console.log(`進行第 ${reconnectAttempts + 1} 次重新連線...`);
        await client.destroy();
        await client.login(process.env.DISCORD_TOKEN);
        
        isConnected = true;
        reconnectAttempts = 0;
        startHeartbeat();
        
        console.log('重新連線成功！');
    } catch (error) {
        console.error('重新連線失敗:', error);
        reconnectAttempts++;
        setTimeout(reconnect, RECONNECT_DELAY);
    }
}

// 初始化對話管理器
const conversationManager = new ConversationManager();

// 訊息處理器
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    try {
        const userMessage = message.content.trim();
        
        if (!userMessage) {
            await message.reply('請輸入訊息，我在這裡等你聊天！');
            return;
        }

        // 處理天氣查詢
        if (userMessage.startsWith('!天氣')) {
            const city = userMessage.split(' ')[1];
            if (!city) {
                await message.reply('請輸入城市名稱，例如 !天氣 台北');
                return;
            }

            try {
                const [current, forecast] = await Promise.all([
                    WeatherService.getCurrentWeather(city),
                    WeatherService.getForecast(city)
                ]);
                const response = WeatherService.formatWeatherResponse(current, forecast);
                await message.reply(response);
            } catch (error) {
                console.error('天氣 API 錯誤:', error);
                await message.reply('查詢天氣失敗，請確認城市名稱是否正確！');
            }
            return;
        }

        // 處理聊天訊息
        const conversationHistory = conversationManager.getHistory(message.author.id);
        conversationManager.addMessage(message.author.id, { role: 'user', content: userMessage });

        const botReply = await ChatService.getResponse(conversationHistory);
        await message.reply(botReply);

        conversationManager.addMessage(message.author.id, { role: 'assistant', content: botReply });

    } catch (error) {
        console.error('訊息處理錯誤:', error);
        await message.reply('很抱歉，處理訊息時發生錯誤。請稍後再試！');
    }
});

// Discord 事件處理
client.on('ready', () => {
    console.log(`✅ 機器人 ${client.user.tag} 已成功登入！`);
    isConnected = true;
    startHeartbeat();
});

client.on('disconnect', () => {
    console.log('機器人已斷線');
    isConnected = false;
    reconnect();
});

client.on('reconnecting', () => {
    console.log('正在重新連線中...');
    isConnected = false;
});

client.on('resume', () => {
    console.log('連線已恢復！');
    isConnected = true;
});

// 優化錯誤處理
client.on('error', error => {
    console.error('Discord 客戶端錯誤:', error);
    isConnected = false;
    reconnect();
});

// 處理未捕獲的錯誤
process.on('unhandledRejection', (error) => {
    console.error('未處理的 Promise 拒絕:', error);
});

process.on('uncaughtException', (error) => {
    console.error('未捕獲的異常:', error);
    if (!isConnected) {
        reconnect();
    }
});

// 啟動 Discord 機器人
client.login(process.env.DISCORD_TOKEN)
    .then(() => {
        console.log('✅ 機器人初始登入成功');
        isConnected = true;
        startHeartbeat();
    })
    .catch(error => {
        console.error('❌ 登入失敗:', error);
        reconnect();
    });