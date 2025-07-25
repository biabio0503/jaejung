const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

const tokens = new Set();

app.post("/save-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    tokens.add(token);
    console.log("✅ 토큰 등록:", token);
  }
  res.send("토큰 저장 완료");
});

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
    results.push(await response.json());
  }

  res.send({ status: "ok", results });
});

app.get("/", (_, res) => {
  res.send("📡 Expo Push 알림 서버 작동 중!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중 on ${PORT}`);
});
