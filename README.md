# Brand Studio - 배포 가이드

## 🚀 5분 만에 배포하기 (Vercel 무료)

### 사전 준비
1. **GitHub 계정** 만들기 → https://github.com/signup
2. **Vercel 계정** 만들기 → https://vercel.com (GitHub으로 로그인)
3. **Firebase 프로젝트** (이미 있다면 그대로 사용)

---

### Step 1: GitHub에 코드 올리기

1. GitHub에서 **New Repository** 클릭
2. Repository name: `brand-studio` 입력
3. **Private** 선택 (코드 비공개)
4. Create repository 클릭

터미널(명령 프롬프트)에서:
```bash
cd brand-studio
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/brand-studio.git
git push -u origin main
```

### Step 2: Vercel에서 배포

1. https://vercel.com/new 접속
2. **Import Git Repository** → 방금 만든 `brand-studio` 선택
3. Framework Preset: **Vite** 자동 감지됨
4. **Deploy** 클릭
5. 약 1-2분 후 `https://brand-studio-xxxxx.vercel.app` 주소 생성!

### Step 3: Firebase 설정

`index.html` 파일에서 Firebase config를 본인 프로젝트 값으로 교체:

```javascript
window.__firebase_config = JSON.stringify({
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
});
```

Firebase Console → 프로젝트 설정 → 일반 → 웹 앱에서 복사할 수 있습니다.

⚠️ **Firebase 없이도 동작합니다** — 레퍼런스 저장 기능만 비활성화됩니다. Gemini API 이미지 생성은 정상 작동합니다.

---

## 📱 로컬에서 테스트하기

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속

---

## 🔑 Gemini API Key

앱 우측 상단의 **API Key 설정** 버튼에서 입력하면 브라우저에 저장됩니다.
Google AI Studio에서 무료 키 발급: https://aistudio.google.com/apikey

---

## ⚠️ 중요 참고사항

- **API Key 보안**: 이 앱은 클라이언트 사이드에서 Gemini API를 직접 호출합니다. 
  공개 배포 시 API 키가 노출될 수 있으므로, 내부 팀용으로만 사용하거나
  Gemini API의 키 제한(IP/도메인) 설정을 권장합니다.
- **Firebase 필수 아님**: Firebase 없이도 이미지 생성 기능은 정상 작동합니다.
- **이미지 저장**: 생성된 이미지는 서버에 저장되지 않습니다. 다운로드 버튼으로 로컬 저장하세요.
