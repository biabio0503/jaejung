const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

const tokens = new Set();

// 1️⃣ Expo 앱에서 토큰 저장
app.post("/save-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    tokens.add(token);
    console.log("✅ 토큰 등록:", token);
    res.status(200).send("토큰 저장 완료");
  } else {
    res.status(400).send("토큰이 필요합니다");
  }
});

// 2️⃣ 저장된 토큰 확인용 (디버깅)
app.get("/tokens", (_, res) => {
  res.json(Array.from(tokens));
});

// 3️⃣ 알림 발송
app.post("/notify", async (req, res) => {
  const { title, body } = req.body;
  const results = [];

  for (const token of tokens) {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: token,
        title,
        body,
      }),
    });
    const result = await response.json();
    console.log("📬 푸시 응답:", result);
    results.push(result);
  }

  res.send({ status: "ok", results });
});

// 4️⃣ 서버 상태 확인용
app.get("/", (_, res) => {
  res.send("📡 Expo Push 알림 서버 작동 중!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중 on ${PORT}`);
});
