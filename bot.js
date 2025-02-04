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

// 對話管理類別
class ConversationManager {
    constructor() {
        this.conversations = new Map();
    }

    getHistory(userId) {
        if (!this.conversations.has(userId)) {
            this.conversations.set(userId, [{
                role: 'system',
                content: '你是個專精於繁體中文的聊天助手。請以繁體中文回應所有訊息，並避免混用其他語言或字符。'
            }]);
        }
        return this.conversations.get(userId);
    }

    addMessage(userId, message) {
        const history = this.getHistory(userId);
        history.push(message);
        
        // 保持歷史記錄在限制範圍內
        if (history.length > MAX_HISTORY_LENGTH) {
            history.splice(1, history.length - MAX_HISTORY_LENGTH);
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

// 聊天服務類別
class ChatService {
    static async getResponse(messages) {
        let attempts = 0;
        while (attempts < MAX_RETRIES) {
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
                    }
                );
                
                const reply = response.data.choices?.[0]?.message?.content;
                if (!reply?.trim()) {
                    throw new Error('收到空回應');
                }
                return reply;
            } catch (error) {
                attempts++;
                if (attempts === MAX_RETRIES) throw error;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
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

// Discord 客戶端錯誤處理
client.on('error', error => {
    console.error('Discord 客戶端錯誤:', error);
});

// 啟動 Discord 機器人
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('✅ 機器人已成功登入'))
    .catch(error => console.error('❌ 登入失敗:', error));