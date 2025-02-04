require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');

const express = require('express');
const app = express();

// 設置一個簡單的 HTTP 端口監聽
app.listen(process.env.PORT || 3000, () => {
    console.log('伺服器正在監聽端口 3000...');
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // 確保可以讀取訊息內容
    ],
});

const WEATHER_API_KEY = process.env.WEATHER_API_KEY; // OpenWeather API Key
const GROQ_API_KEY = process.env.GROQ_API_KEY; // Groq API Key

let conversationHistory = [];

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


// 設定系統訊息，確保使用繁體中文
const systemMessage = {
    role: 'system',
    content: '你是個專精於繁體中文的聊天助手。請以繁體中文回應所有訊息，並避免混用其他語言或字符。',
};

client.on('messageCreate', async (message) => {
    if (message.author.bot) return; // 忽略機器人訊息

    try {
        const userMessage = message.content.trim(); // 去掉多餘的空白
        console.log('收到訊息:', userMessage); // 顯示收到的訊息，方便調試

        if (!userMessage) {
            message.reply('請輸入訊息，我在這裡等你聊天！');
            return;
        }

        // **檢查是否為天氣查詢**
        if (userMessage.startsWith('!天氣')) {
            let city = userMessage.split(' ')[1]; // 取得城市名稱
            if (!city) return message.reply('請輸入城市名稱，例如 !天氣 台北');

            // **將輸入的城市名稱轉換為 API 可識別的名稱**
            city = cityMapping[city] || city;

            try {
                // 查詢當前天氣
                const currentWeatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_tw`;
                const currentWeatherRes = await axios.get(currentWeatherUrl);
                const currentWeather = currentWeatherRes.data;

                // 查詢未來 3 天的天氣預報
                const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_tw`;
                const forecastRes = await axios.get(forecastUrl);
                const forecastList = forecastRes.data.list;

                // 整理未來 3 天的天氣預測
                let forecastMsg = "";
                const dailyForecasts = {};

                forecastList.forEach((item) => {
                    const date = item.dt_txt.split(' ')[0]; // 取得日期
                    if (!dailyForecasts[date]) {
                        dailyForecasts[date] = item; // 每天只取第一個資料點
                    }
                });

                Object.keys(dailyForecasts).slice(0, 3).forEach((date) => {
                    const forecast = dailyForecasts[date];
                    forecastMsg += `📅 **${date}**：${forecast.weather[0].description}，🌡 溫度 ${forecast.main.temp}°C，🌬 風速 ${forecast.wind.speed}m/s\n`;
                });

                // 組合回應訊息
                const reply =`
                    
            📍 **${currentWeather.name}** 的天氣：
            🌡 當前溫度: ${currentWeather.main.temp}°C
            🌬 風速: ${currentWeather.wind.speed}m/s
            ☁ 天氣: ${currentWeather.weather[0].description}
            🔮 **未來 3 天天氣預報：**
            ${forecastMsg}`;

                return message.reply(reply);
            } catch (error) {
                console.error('查詢天氣時發生錯誤：', error);
                return message.reply('查詢天氣失敗，請確認城市名稱是否正確！');
            }
        }

        // **處理一般聊天對話**
        conversationHistory.unshift(systemMessage);
        conversationHistory.push({ role: 'user', content: userMessage });

        // **限制對話歷史訊息的數量**
        const MAX_HISTORY_LENGTH = 10;
        if(conversationHistory.length > MAX_HISTORY_LENGTH){
            conversationHistory = conversationHistory.slice(0, MAX_HISTORY_LENGTH);
        }

        // 發送請求到 Groq API
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama3-70b-8192',
                messages: conversationHistory, // 包含歷史對話
            },
            {
                headers: {
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        const botReply = response.data.choices[0].message.content;

        // 發送回覆
        message.reply(botReply);

        // 更新對話歷史
        conversationHistory.push({ role: 'assistant', content: botReply });

    } catch (error) {
        console.error('Groq API 發生錯誤：', error.response ? error.response.data : error);
        message.reply('發生錯誤，請稍後再試！');
    }
});

// 登入 Discord bot
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log('✅ Bot has logged in successfully!'))
    .catch((error) => console.error('❌ Login failed:', error));