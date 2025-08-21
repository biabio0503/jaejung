// server-with-apns.js

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const apn = require("apn");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();

// 이벤트 리스너 제한 늘리기
process.setMaxListeners(20);
require("events").EventEmitter.defaultMaxListeners = 20;

app.use(cors());
app.use(express.json());

// 메모리 내 토큰 저장소
const expoTokens = new Set();
const apnsTokens = new Set();
const fcmTokens = new Set();

/* =========================
   APNs 설정 및 초기화
   ========================= */
const apnsOptions = {
  token: {
    // Render Secret Files로 p8 업로드 시: APNS_KEY_ID=XXXX, 파일명: /etc/secrets/AuthKey_XXXX.p8
    key: process.env.APNS_KEY_ID
      ? `/etc/secrets/AuthKey_${process.env.APNS_KEY_ID}.p8`
      : null,
    keyId: process.env.APNS_KEY_ID || "6Q77597HG7",
    teamId: process.env.APNS_TEAM_ID || "L22225APBP",
  },
  production: (process.env.APNS_ENVIRONMENT || "production") === "production",
};

let apnsProvider = null;

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

/* =========================
   Firebase Admin 초기화 (Render 대응)
   ========================= */
let firebaseApp = null;
try {
  const projectId = process.env.FIREBASE_PROJECT_ID || "jaejung-a5d25";
  let credential = null;

  // 1) 환경변수 기반 서비스 계정
  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    credential = admin.credential.cert({
      projectId,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    });
    console.log("✅ Firebase Admin 자격증명: ENV 서비스 계정 사용");
  }
  // 2) Secret File 경로 제공 시
  else if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ) {
    credential = admin.credential.applicationDefault();
    console.log("✅ Firebase Admin 자격증명: GOOGLE_APPLICATION_CREDENTIALS 사용");
  } else {
    console.warn("⚠️ Firebase Admin 자격증명을 찾지 못했습니다. FCM 발송이 비활성화될 수 있습니다.");
  }

  if (credential) {
    firebaseApp = admin.initializeApp({
      credential,
      projectId,
    });
    console.log("✅ Firebase Admin 초기화 완료");
  }
} catch (error) {
  console.log("⚠️ Firebase Admin 초기화 실패:", error.message);
}

// Firebase Admin 이벤트 리스너 제한
if (firebaseApp) {
  try {
    admin.messaging().setMaxListeners(20);
  } catch (e) {
    console.log("⚠️ Firebase messaging 리스너 설정 실패:", e.message);
  }
}

// 서버 시작 시 APNs 초기화
initAPNs();

/* =========================
   토큰 저장/조회 API
   ========================= */
// 1) Expo Push 토큰 저장
app.post("/save-token", (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    expoTokens.add(cleaned);
    console.log("✅ Expo 토큰 등록:", cleaned);
    return res.status(200).send("Expo 토큰 저장 완료");
  }
  res.status(400).send("토큰이 필요합니다");
});

// 2) APNs 토큰 저장
app.post("/save-apns-token", (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    apnsTokens.add(cleaned);
    console.log("🍎 APNs 토큰 등록:", cleaned);
    return res.status(200).send("APNs 토큰 저장 완료");
  }
  res.status(400).send("APNs 토큰이 필요합니다");
});

// 3) FCM 토큰 저장
app.post("/save-fcm-token", (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    fcmTokens.add(cleaned);
    console.log("🤖 FCM 토큰 등록:", cleaned);
    return res.status(200).send("FCM 토큰 저장 완료");
  }
  res.status(400).send("FCM 토큰이 필요합니다");
});

// 4) 저장된 토큰 확인
app.get("/tokens", (_, res) => {
  res.json({
    expo: Array.from(expoTokens),
    apns: Array.from(apnsTokens),
    fcm: Array.from(fcmTokens),
  });
});

/* =========================
   알림 발송 API (Expo + APNs + FCM)
   ========================= */
app.post("/notify", async (req, res) => {
  const { title, body } = req.body || {};
  const results = [];

  // 1) Expo Push
  for (const token of expoTokens) {
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: token, title, body }),
      });
      const result = await response.json();
      console.log("📬 Expo 푸시 응답:", result);
      results.push({ type: "expo", token, result });
    } catch (error) {
      console.error("❌ Expo 푸시 실패:", error);
      results.push({ type: "expo", token, error: error.message });
    }
  }

  // 2) APNs
  if (apnsProvider && apnsTokens.size > 0) {
    const notification = new apn.Notification();
    notification.alert = { title, body };
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

  // 3) FCM
  if (firebaseApp && fcmTokens.size > 0) {
    const messageBase = {
      notification: { title, body },
      android: {
        notification: {
          sound: "default",
          channel_id: "default",
        },
      },
      apns: {
        payload: { aps: { sound: "default" } },
      },
    };

    for (const token of fcmTokens) {
      try {
        const result = await admin.messaging().send({ ...messageBase, token });
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

/* =========================
   헬스체크
   ========================= */
app.get("/", (_, res) => {
  res.json({
    message: "📡 Expo + APNs + FCM 푸시 알림 서버 작동 중!",
    stats: {
      expoTokens: expoTokens.size,
      apnsTokens: apnsTokens.size,
      fcmTokens: fcmTokens.size,
      apnsProvider: apnsProvider ? "초기화됨" : "초기화 안됨",
      firebaseApp: firebaseApp ? "초기화됨" : "초기화 안됨",
    },
  });
});

/* =========================
   서버 시작
   ========================= */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 서버 실행 중 on ${PORT}`);
  console.log("📱 APNs 설정:", {
    keyId: apnsOptions.token.keyId,
    teamId: apnsOptions.token.teamId,
    production: apnsOptions.production,
    bundleId: process.env.APNS_BUNDLE_ID,
  });
  console.log("🤖 Firebase 설정:", {
    projectId: process.env.FIREBASE_PROJECT_ID || "jaejung-a5d25",
    initialized: firebaseApp ? "성공" : "실패",
  });
});

// 서버 이벤트 리스너 제한
server.setMaxListeners(20);
