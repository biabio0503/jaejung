const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const apn = require("apn");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

const tokens = new Set();
const apnsTokens = new Set();
const fcmTokens = new Set();

// APNs 설정
const apnsOptions = {
  token: {
    key: process.env.APNS_KEY_ID ? `/etc/secrets/AuthKey_${process.env.APNS_KEY_ID}.p8` : null,
    keyId: process.env.APNS_KEY_ID || "6Q77597HG7",
    teamId: process.env.APNS_TEAM_ID || "L22225APBP"
  },
  production: (process.env.APNS_ENVIRONMENT || "production") === "production"
};

let apnsProvider = null;

// Firebase Admin 초기화
let firebaseApp = null;
try {
  firebaseApp = admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: "jaejung-a5d25"
  });
  console.log("✅ Firebase Admin 초기화 완료");
} catch (error) {
  console.log("⚠️ Firebase Admin 초기화 실패:", error.message);
}

// APNs 프로바이더 초기화
function initAPNs() {
  try {
    if (apnsOptions.token.key && fs.existsSync(apnsOptions.token.key)) {
      apnsProvider = new apn.Provider(apnsOptions);
      console.log("✅ APNs 프로바이더 초기화 완료");
    } else {
      console.log("⚠️ APNs 키 파일을 찾을 수 없습니다");
    }
  } catch (error) {
    console.error("❌ APNs 초기화 실패:", error);
  }
}

// 서버 시작 시 APNs 초기화
initAPNs();

// 1️⃣ Expo 앱에서 토큰 저장
app.post("/save-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    tokens.add(token);
    console.log("✅ Expo 토큰 등록:", token);
    res.status(200).send("Expo 토큰 저장 완료");
  } else {
    res.status(400).send("토큰이 필요합니다");
  }
});

// 2️⃣ APNs 토큰 저장
app.post("/save-apns-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    apnsTokens.add(token);
    console.log("🍎 APNs 토큰 등록:", token);
    res.status(200).send("APNs 토큰 저장 완료");
  } else {
    res.status(400).send("APNs 토큰이 필요합니다");
  }
});

// 3️⃣ FCM 토큰 저장
app.post("/save-fcm-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    fcmTokens.add(token);
    console.log("�� FCM 토큰 등록:", token);
    res.status(200).send("FCM 토큰 저장 완료");
  } else {
    res.status(400).send("FCM 토큰이 필요합니다");
  }
});

// 4️⃣ 저장된 토큰 확인용 (디버깅)
app.get("/tokens", (_, res) => {
  res.json({
    expo: Array.from(tokens),
    apns: Array.from(apnsTokens),
    fcm: Array.from(fcmTokens)
  });
});

// 5️⃣ 알림 발송 (Expo + APNs + FCM)
app.post("/notify", async (req, res) => {
  const { title, body } = req.body;
  const results = [];

  // Expo Push 발송
  for (const token of tokens) {
    try {
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
      console.log("📬 Expo 푸시 응답:", result);
      results.push({ type: "expo", token, result });
    } catch (error) {
      console.error("❌ Expo 푸시 실패:", error);
      results.push({ type: "expo", token, error: error.message });
    }
  }

  // APNs 발송
  if (apnsProvider && apnsTokens.size > 0) {
    const notification = new apn.Notification();
    notification.alert = {
      title: title,
      body: body
    };
    notification.topic = process.env.APNS_BUNDLE_ID || "com.jaejung.myappj.v2";
    notification.sound = "default";

    for (const token of apnsTokens) {
      try {
        const result = await apnsProvider.send(notification, token);
        console.log("🍎 APNs 푸시 응답:", result);
        results.push({ type: "apns", token, result });
      } catch (error) {
        console.error("❌ APNs 푸시 실패:", error);
        results.push({ type: "apns", token, error: error.message });
      }
    }
  }

  // FCM 발송
  if (firebaseApp && fcmTokens.size > 0) {
    const message = {
      notification: {
        title: title,
        body: body
      },
      android: {
        notification: {
          sound: 'default',
          channel_id: 'default'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };

    for (const token of fcmTokens) {
      try {
        const result = await admin.messaging().send({
          ...message,
          token: token
        });
        console.log("🤖 FCM 푸시 응답:", result);
        results.push({ type: "fcm", token, result });
      } catch (error) {
        console.error("❌ FCM 푸시 실패:", error);
        results.push({ type: "fcm", token, error: error.message });
      }
    }
  }

  res.send({ status: "ok", results });
});

// 6️⃣ 서버 상태 확인용
app.get("/", (_, res) => {
  res.json({
    message: "📡 Expo + APNs + FCM 푸시 알림 서버 작동 중!",
    stats: {
      expoTokens: tokens.size,
      apnsTokens: apnsTokens.size,
      fcmTokens: fcmTokens.size,
      apnsProvider: apnsProvider ? "초기화됨" : "초기화 안됨",
      firebaseApp: firebaseApp ? "초기화됨" : "초기화 안됨"
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중 on ${PORT}`);
  console.log(`📱 APNs 설정:`, {
    keyId: apnsOptions.token.keyId,
    teamId: apnsOptions.token.teamId,
    production: apnsOptions.production,
    bundleId: process.env.APNS_BUNDLE_ID
  });
  console.log(`🤖 Firebase 설정:`, {
    projectId: "jaejung-a5d25",
    initialized: firebaseApp ? "성공" : "실패"
  });
});
