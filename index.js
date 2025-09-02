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

// Firebase Realtime Database를 활용한 토큰 저장소
let expoTokens = new Set();
let apnsTokens = new Set();
let fcmTokens = new Set();

// Firebase Realtime Database URL
const FIREBASE_DB_URL = "https://jaejung-a5d25-default-rtdb.asia-southeast1.firebasedatabase.app";

// 토큰을 Firebase에 저장
const saveTokenToFirebase = async (tokenType, token) => {
  try {
    const response = await fetch(`${FIREBASE_DB_URL}/pushTokens/${tokenType}/${token.replace(/[.#$[\]]/g, '_')}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token,
        registeredAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      })
    });
    
    if (response.ok) {
      console.log(`✅ ${tokenType} 토큰 Firebase 저장 성공:`, token.substring(0, 20) + "...");
      return true;
    } else {
      console.error(`❌ ${tokenType} 토큰 Firebase 저장 실패:`, response.status);
      return false;
    }
  } catch (error) {
    console.error(`❌ ${tokenType} 토큰 Firebase 저장 오류:`, error.message);
    return false;
  }
};

// Firebase에서 토큰 불러오기
const loadTokensFromFirebase = async () => {
  try {
    console.log("🔄 Firebase에서 토큰 불러오기 시작...");
    
    const [expoResponse, apnsResponse, fcmResponse] = await Promise.all([
      fetch(`${FIREBASE_DB_URL}/pushTokens/expo.json`),
      fetch(`${FIREBASE_DB_URL}/pushTokens/apns.json`),
      fetch(`${FIREBASE_DB_URL}/pushTokens/fcm.json`)
    ]);
    
    // Expo 토큰 불러오기
    if (expoResponse.ok) {
      const expoData = await expoResponse.json();
      if (expoData) {
        Object.keys(expoData).forEach(key => {
          const tokenData = expoData[key];
          if (tokenData && tokenData.token) {
            expoTokens.add(tokenData.token);
          }
        });
        console.log(`📱 Firebase에서 ${expoTokens.size}개의 Expo 토큰 불러옴`);
      }
    }
    
    // APNs 토큰 불러오기
    if (apnsResponse.ok) {
      const apnsData = await apnsResponse.json();
      if (apnsData) {
        Object.keys(apnsData).forEach(key => {
          const tokenData = apnsData[key];
          if (tokenData && tokenData.token) {
            apnsTokens.add(tokenData.token);
          }
        });
        console.log(`🍎 Firebase에서 ${apnsTokens.size}개의 APNs 토큰 불러옴`);
      }
    }
    
    // FCM 토큰 불러오기
    if (fcmResponse.ok) {
      const fcmData = await fcmResponse.json();
      if (fcmData) {
        Object.keys(fcmData).forEach(key => {
          const tokenData = fcmData[key];
          if (tokenData && tokenData.token) {
            fcmTokens.add(tokenData.token);
          }
        });
        console.log(`🤖 Firebase에서 ${fcmTokens.size}개의 FCM 토큰 불러옴`);
      }
    }
    
    console.log("✅ Firebase 토큰 불러오기 완료");
  } catch (error) {
    console.error("❌ Firebase 토큰 불러오기 실패:", error.message);
  }
};

// 토큰 사용 시간 업데이트
const updateTokenLastUsed = async (tokenType, token) => {
  try {
    await fetch(`${FIREBASE_DB_URL}/pushTokens/${tokenType}/${token.replace(/[.#$[\]]/g, '_')}/lastUsed.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(new Date().toISOString())
    });
  } catch (error) {
    console.error(`❌ ${tokenType} 토큰 사용 시간 업데이트 실패:`, error.message);
  }
};

// 오래된 토큰 정리 (30일 이상 사용되지 않은 토큰)
const cleanupOldTokens = async () => {
  try {
    console.log("🧹 오래된 토큰 정리 시작...");
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const tokenTypes = ['expo', 'apns', 'fcm'];
    
    for (const tokenType of tokenTypes) {
      const response = await fetch(`${FIREBASE_DB_URL}/pushTokens/${tokenType}.json`);
      if (response.ok) {
        const data = await response.json();
        if (data) {
          for (const [key, tokenData] of Object.entries(data)) {
            if (tokenData.lastUsed && new Date(tokenData.lastUsed) < new Date(thirtyDaysAgo)) {
              // 오래된 토큰 삭제
              await fetch(`${FIREBASE_DB_URL}/pushTokens/${tokenType}/${key}.json`, {
                method: 'DELETE'
              });
              console.log(`🗑️ 오래된 ${tokenType} 토큰 삭제:`, tokenData.token.substring(0, 20) + "...");
            }
          }
        }
      }
    }
    
    console.log("✅ 오래된 토큰 정리 완료");
  } catch (error) {
    console.error("❌ 오래된 토큰 정리 실패:", error.message);
  }
};

// 서버 시작 시 토크 불러오기
loadTokensFromFirebase().then(() => {
  // 24시간마다 오래된 토큰 정리
  setInterval(cleanupOldTokens, 24 * 60 * 60 * 1000);
});

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
app.post("/save-token", async (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    // Firebase에 저장
    const success = await saveTokenToFirebase("expo", cleaned);
    if (success) {
      // 메모리에도 추가
      expoTokens.add(cleaned);
      console.log("✅ Expo 토큰 등록 (Firebase + 메모리):", cleaned.substring(0, 20) + "...");
      return res.status(200).send("Expo 토큰 저장 완료");
    } else {
      console.error("❌ Expo 토큰 Firebase 저장 실패:", cleaned);
      return res.status(500).send("Expo 토큰 저장 실패");
    }
  }
  res.status(400).send("토큰이 필요합니다");
});

// 2) APNs 토큰 저장
app.post("/save-apns-token", async (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    // Firebase에 저장
    const success = await saveTokenToFirebase("apns", cleaned);
    if (success) {
      // 메모리에도 추가
      apnsTokens.add(cleaned);
      console.log("🍎 APNs 토큰 등록 (Firebase + 메모리):", cleaned.substring(0, 20) + "...");
      return res.status(200).send("APNs 토큰 저장 완료");
    } else {
      console.error("❌ APNs 토큰 Firebase 저장 실패:", cleaned);
      return res.status(500).send("APNs 토큰 저장 실패");
    }
  }
  res.status(400).send("APNs 토큰이 필요합니다");
});

// 3) FCM 토큰 저장
app.post("/save-fcm-token", async (req, res) => {
  const cleaned = (req.body?.token ?? "").toString().trim();
  if (cleaned) {
    // Firebase에 저장
    const success = await saveTokenToFirebase("fcm", cleaned);
    if (success) {
      // 메모리에도 추가
      fcmTokens.add(cleaned);
      console.log("🤖 FCM 토큰 등록 (Firebase + 메모리):", cleaned.substring(0, 20) + "...");
      return res.status(200).send("FCM 토큰 저장 완료");
    } else {
      console.error("❌ FCM 토큰 Firebase 저장 실패:", cleaned);
      return res.status(500).send("FCM 토큰 저장 실패");
    }
  }
  res.status(400).send("FCM 토큰이 필요합니다");
});

// 4) 저장된 토큰 확인
app.get("/tokens", async (_, res) => {
  res.json({
    expo: Array.from(expoTokens),
    apns: Array.from(apnsTokens),
    fcm: Array.from(fcmTokens),
    total: expoTokens.size + apnsTokens.size + fcmTokens.size
  });
});

// 5) 토큰 상태 확인
app.get("/token-status", async (_, res) => {
  try {
    const [expoResponse, apnsResponse, fcmResponse] = await Promise.all([
      fetch(`${FIREBASE_DB_URL}/pushTokens/expo.json`),
      fetch(`${FIREBASE_DB_URL}/pushTokens/apns.json`),
      fetch(`${FIREBASE_DB_URL}/pushTokens/fcm.json`)
    ]);
    
    const expoCount = expoResponse.ok ? Object.keys(await expoResponse.json() || {}).length : 0;
    const apnsCount = apnsResponse.ok ? Object.keys(await apnsResponse.json() || {}).length : 0;
    const fcmCount = fcmResponse.ok ? Object.keys(await fcmResponse.json() || {}).length : 0;
    
    res.json({
      memory: {
        expo: expoTokens.size,
        apns: apnsTokens.size,
        fcm: fcmTokens.size
      },
      firebase: {
        expo: expoCount,
        apns: apnsCount,
        fcm: fcmCount
      },
      server: {
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6) 토큰 강제 새로고침 (서버 재시작 없이 Firebase에서 다시 불러오기)
app.post("/refresh-tokens", async (_, res) => {
  try {
    console.log("🔄 토큰 강제 새로고침 시작...");
    
    // 기존 메모리 토큰 초기화
    expoTokens.clear();
    apnsTokens.clear();
    fcmTokens.clear();
    
    // Firebase에서 다시 불러오기
    await loadTokensFromFirebase();
    
    res.json({
      message: "토큰 새로고침 완료",
      counts: {
        expo: expoTokens.size,
        apns: apnsTokens.size,
        fcm: fcmTokens.size
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 7) 오래된 토큰 정리 API
app.post("/cleanup-tokens", async (_, res) => {
  try {
    await cleanupOldTokens();
    res.json({ message: "오래된 토큰 정리 완료" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
      
      // 토큰 사용 시간 업데이트
      await updateTokenLastUsed("expo", token);
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
        
        // 토큰 사용 시간 업데이트
        await updateTokenLastUsed("apns", token);
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
app.get("/", async (_, res) => {
  await updateTokenLastUsed("expo", Array.from(expoTokens)[0]); // 토큰 사용 시간 업데이트
  await updateTokenLastUsed("apns", Array.from(apnsTokens)[0]); // 토큰 사용 시간 업데이트
  await updateTokenLastUsed("fcm", Array.from(fcmTokens)[0]); // 토큰 사용 시간 업데이트

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
server.setMaxListeners(50);
