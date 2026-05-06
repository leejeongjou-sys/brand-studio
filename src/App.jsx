import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Palette, ChevronLeft, Sparkles, Plus, Image as ImageIcon,
  CheckCircle2, XCircle, Loader2, Tag,
  Download, UploadCloud, FileUp, Trash2, AlertTriangle, FilePlus,
  Pencil, Database, Key, Settings, X, Wand2, BookOpen,
  Shirt, MessageSquarePlus, Maximize2, UserCheck, Smartphone, Monitor,
  RefreshCcw, Save, Layers, Scissors, PlusCircle, MinusCircle, Highlighter,
  Package, Camera, ChevronRight, Sun,
  ArrowUp, ArrowDown
} from 'lucide-react';

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithCustomToken,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth';
import {
  initializeFirestore,
  memoryLocalCache,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';

/* global __app_id, __firebase_config, __initial_auth_token */

// --- CONSTANTS & CONFIGURATION ---
const FIXED_BRANDS = ['EZ', 'FP', 'JM', 'PS', 'WV'];
const apiKey = ""; // System injected key
const DEFAULT_API_KEY = apiKey;

// HIGH-END FASHION STYLE GUIDELINES WITH MAXIMUM QUALITY (Face Consistency Enhanced)
const HIGH_END_STYLE_PROMPT = `
MANDATORY STYLE GUIDELINES FOR ABSOLUTE REALISM (ANTI-AI LOOK):
- CRITICAL: The final image MUST NOT look like AI. Eliminate all artificial gloss, excessive symmetry, and plastic-like skin. Force genuine photographic realism with physical micro-imperfections.
- RAW, unedited analog film photography aesthetic (35mm or medium format)
- Subtle, natural film grain and organic color rendering
- Avoid "8K perfect" CGI look; embrace photographic micro-imperfections
- EXTREME MICRO-DETAIL RETENTION: Absolutely NO plastic skin smoothing. Visible pores, peach fuzz, microscopic skin imperfections, and natural skin texture must be highly detailed and realistic.
- HYPER-REALISTIC TEXTILES: Fabric must show macro-level thread weave, distinct material textures (e.g., fuzz on wool, grain on leather, warp/weft on cotton), and realistic thread tension. Fabric should not look "melted", blurry, or artificially smooth.
- Asymmetrical, spontaneous, and relaxed posture (not stiff, not mannequin-like, weight shifted naturally)
- Authentic facial expression: relaxed facial muscles, slightly asymmetrical, breathing lips, capturing a candid moment
- Organic hair movement with natural flyaways and realistic volume
- Natural fall-off in lighting with deep, authentic shadows (not perfectly lit from every angle)
- Authentic fabric draping with natural wrinkles, realistic weight, and genuine thread tension
- Pure editorial fashion photography, looking like a candid documentary moment caught on camera
`;

const getAppId = () => {
  return typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
};

// Gemini Image Models
const MODEL_OPTIONS = {
  PRO: 'gemini-3.1-flash-image-preview',
  LITE: 'gemini-3.1-flash-lite-preview'
};

const ANALYSIS_MODEL_ID = 'gemini-3.1-flash-image-preview';

// --- SINGLETON FIREBASE INITIALIZATION ---
let firebaseApp;
let firebaseAuth;
let firebaseDb;
let authPersistenceSet = false;

const getFirebase = () => {
  if (!firebaseApp) {
    try {
      const configString = typeof __firebase_config !== 'undefined' ? __firebase_config : '{}';
      const firebaseConfig = JSON.parse(configString);

      if (Object.keys(firebaseConfig).length > 0) {
        firebaseApp = initializeApp(firebaseConfig);
        firebaseAuth = getAuth(firebaseApp);

        if (!authPersistenceSet) {
          authPersistenceSet = true;
          setPersistence(firebaseAuth, browserLocalPersistence).catch((e) => {
            console.warn("Auth persistence failed:", e);
          });
        }

        firebaseDb = initializeFirestore(firebaseApp, {
          localCache: memoryLocalCache(),
          experimentalForceLongPolling: true,
        });
      }
    } catch (error) {
      console.error("Failed to initialize Firebase:", error);
    }
  }
  return { app: firebaseApp, auth: firebaseAuth, db: firebaseDb };
};

// --- UTILITY FUNCTIONS ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithRetry = async (url, options, retries = 3, backoff = 1000) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 429 && i === retries) throw new Error('API 호출량이 초과되었습니다 (Rate Limit). 잠시 후 다시 시도해주세요.');
      if (res.status < 500 && res.status !== 429) return res;
      if (i < retries) {
        const delayTime = backoff * Math.pow(2, i);
        await delay(delayTime);
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries) {
        const delayTime = backoff * Math.pow(2, i);
        await delay(delayTime);
        continue;
      }
      throw e;
    }
  }
};

const compressImage = (dataUrl, maxWidth = 1024, quality = 0.75) => {
  return new Promise((resolve, reject) => {
    if (!dataUrl) {
      reject(new Error('Invalid dataUrl provided'));
      return;
    }
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));

      canvas.width = 0;
      canvas.height = 0;
    };
    img.onerror = (e) => reject(e);
    img.src = dataUrl;
  });
};

const sanitizeData = (data) => {
  const sanitized = {};
  Object.keys(data).forEach(key => {
    if (data[key] !== undefined) sanitized[key] = data[key];
    else sanitized[key] = null;
  });
  return sanitized;
};

const appendPromptSnippet = (snippet, setter) => {
  setter(prev => {
      if (!prev) return snippet;
      if (prev.endsWith(' ') || prev.endsWith('\n')) return prev + snippet;
      return prev + ', ' + snippet;
  });
};

// --- GEMINI IMAGE CONFIG HELPERS ---
// The "lite" preview model rejects imageConfig.aspectRatio and imageConfig.imageSize.
// Only the full "flash-image-preview" supports them.
const supportsImageSize = (modelId) => {
  const id = modelId || '';
  if (id.includes('lite')) return false;
  return id.includes('image');
};
const supportsAspectRatio = (modelId) => {
  const id = modelId || '';
  if (id.includes('lite')) return false;
  return id.includes('image');
};

const buildImageGenerationConfig = (modelId, aspectRatio, qualityMode = 'std') => {
  const q = qualityMode === 'ultra' ? 'ultra' : 'std';
  const imageConfig = {};
  if (supportsAspectRatio(modelId)) imageConfig.aspectRatio = aspectRatio;
  if (supportsImageSize(modelId)) imageConfig.imageSize = q === 'ultra' ? '4K' : '2K';

  const config = { responseModalities: ['IMAGE'] };
  if (Object.keys(imageConfig).length > 0) config.imageConfig = imageConfig;
  return config;
};

const extractGeminiImageDataUrl = (data) => {
  const candidate = data?.candidates?.[0];
  const imgPart = candidate?.content?.parts?.find(p => p?.inlineData?.data);
  if (imgPart?.inlineData?.data) return `data:image/jpeg;base64,${imgPart.inlineData.data}`;

  const finishReason = candidate?.finishReason;
  const textPart = candidate?.content?.parts?.find(p => p.text)?.text;

  let errorMsg = "이미지가 생성되지 않았습니다.";
  if (finishReason === 'SAFETY') errorMsg = "안전 정책에 의해 생성이 차단되었습니다.";
  else if (finishReason === 'RECITATION') errorMsg = "저작권 문제로 생성이 차단되었습니다.";
  else if (textPart) errorMsg = `모델 거절 메시지: ${textPart}`;

  throw new Error(errorMsg);
};

const geminiGenerateImageOnce = async ({ modelId, apiKey, contentsParts, aspectRatio, qualityMode }) => {
  const generationConfig = buildImageGenerationConfig(modelId, aspectRatio, qualityMode);
  let url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  if (apiKey) url += `?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: contentsParts }], generationConfig })
  });

  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw || 'Invalid JSON' } }; }

  if (!res.ok) throw new Error(`API Error ${res.status}: ${data?.error?.message || raw}`);
  if (data?.error) throw new Error(`API Error: ${data.error.message || 'Unknown Error'}`);

  return extractGeminiImageDataUrl(data);
};

const geminiGenerateImage = async ({ primaryModelId, fallbackModelId, apiKey, contentsParts, aspectRatio, qualityMode }) => {
  try {
    const dataUrl = await geminiGenerateImageOnce({ modelId: primaryModelId, apiKey, contentsParts, aspectRatio, qualityMode });
    return { dataUrl, usedModelId: primaryModelId, didFallback: false };
  } catch (primaryError) {
    if (fallbackModelId && fallbackModelId !== primaryModelId) {
      const dataUrl = await geminiGenerateImageOnce({ modelId: fallbackModelId, apiKey, contentsParts, aspectRatio, qualityMode });
      return { dataUrl, usedModelId: fallbackModelId, didFallback: true, primaryError };
    }
    throw primaryError;
  }
};

const geminiEditImage = async ({ modelId = 'gemini-3.1-flash-image-preview', apiKey, baseImage, detailImages = [], prompt }) => {
  const parts = [{ text: prompt }];
  parts.push({ inlineData: { mimeType: "image/jpeg", data: baseImage.split(',')[1] } });

  if (detailImages && detailImages.length > 0) {
    detailImages.forEach(img => {
      if (img) parts.push({ inlineData: { mimeType: "image/jpeg", data: img.split(',')[1] } });
    });
  }

  let url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
  if (apiKey) url += `?key=${apiKey}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    })
  });

  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: { message: raw || 'Invalid JSON' } }; }

  if (!res.ok) throw new Error(`API Error ${res.status}: ${data?.error?.message || raw}`);
  if (data?.error) throw new Error(`API Error: ${data.error.message || 'Unknown Error'}`);

  const imgPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (imgPart?.inlineData?.data) return `data:image/jpeg;base64,${imgPart.inlineData.data}`;

  const txt = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  throw new Error(txt ? `모델 메시지: ${txt}` : "이미지 보정 결과가 없습니다.");
};

// --- CUSTOM HOOKS ---
const useAuth = () => {
  const [user, setUser] = useState(null);
  useEffect(() => {
    const { auth } = getFirebase();
    if (!auth) return;

    const initAuth = async () => {
      if (auth.currentUser) {
        setUser(auth.currentUser);
        return;
      }
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          const userCredential = await signInWithCustomToken(auth, __initial_auth_token);
          setUser(userCredential.user);
        } else {
          const userCredential = await signInAnonymously(auth);
          setUser(userCredential.user);
        }
      } catch (e) { console.error("Auth init failed:", e); }
    };

    initAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
        if(u) {
            setUser(u);
        }
    });
    return () => unsub();
  }, []);
  return user;
};

const useSettings = (user) => {
    const DEFAULT_SETTINGS = { apiKey: DEFAULT_API_KEY || '', highRes: false, modelId: MODEL_OPTIONS.PRO };
    const [settings, setSettings] = useState(() => {
        try {
            const saved = localStorage.getItem('brand_studio_settings_v3');
            if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        } catch (e) { console.warn(e); }
        return DEFAULT_SETTINGS;
    });

    useEffect(() => {
        localStorage.setItem('brand_studio_settings_v3', JSON.stringify(settings));
    }, [settings]);

    useEffect(() => {
        if (!user?.uid) return;
        const appId = getAppId();
        const { db } = getFirebase();
        if(!db) return;
        const settingsRef = doc(db, 'artifacts', appId, 'users', user.uid, 'preferences', 'general');

        const unsub = onSnapshot(settingsRef, (docSnap) => {
            if (docSnap.exists()) {
                const remoteSettings = docSnap.data();
                setSettings(prev => {
                    if (JSON.stringify(prev) !== JSON.stringify({ ...prev, ...remoteSettings })) {
                        return { ...prev, ...remoteSettings };
                    }
                    return prev;
                });
            }
        });
        return () => unsub();
    }, [user?.uid]);

    const updateSettings = async (newSettings) => {
        setSettings(newSettings);
        if (user) {
            const appId = getAppId();
            const { db } = getFirebase();
            if(!db) return;
            try {
                await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'preferences', 'general'), newSettings, { merge: true });
            } catch (e) { console.error("Failed to sync settings to cloud", e); }
        }
    };

    return [settings, updateSettings];
};

const useAppData = (user) => {
  const [references, setReferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const appId = getAppId();

  useEffect(() => {
    if (!user?.uid) return;
    setLoading(true);
    const { db } = getFirebase();
    if(!db) {
        setLoading(false);
        return;
    }

    const qRef = collection(db, 'artifacts', appId, 'public', 'data', 'references');
    const unsubRef = onSnapshot(qRef, (snapshot) => {
      const items = [];
      snapshot.forEach((d) => items.push({ id: d.id, ...d.data() }));
      items.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setReferences(items);
      setLoading(false);
    }, (error) => { console.error("Error fetching references:", error); setLoading(false); });

    return () => { unsubRef(); };
  }, [user?.uid, appId]);

  const saveReference = async (refData, isUpdate = false, docId = null) => {
    if (!user) throw new Error("Login required");
    const { db } = getFirebase();
    const currentAppId = getAppId();
    const cleanData = sanitizeData(refData);
    if (isUpdate && docId) {
      await updateDoc(doc(db, 'artifacts', currentAppId, 'public', 'data', 'references', docId), { ...cleanData, updatedAt: serverTimestamp() });
    } else {
      const newDoc = { ...cleanData, createdAt: serverTimestamp(), userId: user.uid };
      await addDoc(collection(db, 'artifacts', currentAppId, 'public', 'data', 'references'), newDoc);
    }
  };

  const deleteReference = async (refId) => {
    if (!user) return;
    const { db } = getFirebase();
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'references', refId));
  };

  const importReferences = async (dataList) => {
      if (!user) return;
      const { db } = getFirebase();
      const currentAppId = getAppId();
      for (const item of dataList) {
        const { id, ...rest } = item;
        const docData = { ...sanitizeData(rest), userId: user.uid, createdAt: serverTimestamp(), importedAt: new Date().toISOString() };
        try { await addDoc(collection(db, 'artifacts', currentAppId, 'public', 'data', 'references'), docData); await delay(500); } catch (e) { console.error(e); }
      }
    };

  return { references, loading, saveReference, deleteReference, importReferences };
};

// --- UI COMPONENTS ---

const ImageViewerModal = ({ isOpen, onClose, imageSrc }) => {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);           // absolute scale where 1 = native pixel size
  const [fitScale, setFitScale] = useState(1);     // scale that makes the image fit the viewport
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, offX: 0, offY: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);

  // Reset whenever we open a new image
  useEffect(() => {
    if (isOpen) {
      setScale(0);
      setFitScale(1);
      setOffset({ x: 0, y: 0 });
      setNatural({ w: 0, h: 0 });
      setLoaded(false);
    }
  }, [isOpen, imageSrc]);

  const computeFit = (w, h) => {
    const el = containerRef.current;
    if (!el || !w || !h) return 1;
    const rect = el.getBoundingClientRect();
    // margin so the image doesn't hug the edges
    const pad = 0.95;
    return Math.min((rect.width * pad) / w, (rect.height * pad) / h);
  };

  const handleImgLoad = (e) => {
    const img = e.currentTarget;
    const fs = computeFit(img.naturalWidth, img.naturalHeight);
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    setFitScale(fs);
    setScale(fs);
    setOffset({ x: 0, y: 0 });
    setLoaded(true);
  };

  const minScale = fitScale;
  const maxScale = Math.max(1, fitScale) * 4; // allow up to 4x native or fit-x4

  const clampScale = (s) => Math.max(minScale, Math.min(maxScale, s));

  const handleWheel = (e) => {
    if (!loaded) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = clampScale(scale * factor);
    // Zoom centered on cursor
    const el = containerRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = newScale / scale;
      setOffset({
        x: cx - (cx - offset.x) * ratio,
        y: cy - (cy - offset.y) * ratio,
      });
    }
    setScale(newScale);
  };

  const handleMouseDown = (e) => {
    if (scale <= fitScale + 1e-4) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, offX: offset.x, offY: offset.y };
  };
  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setOffset({
      x: dragStart.current.offX + (e.clientX - dragStart.current.x),
      y: dragStart.current.offY + (e.clientY - dragStart.current.y),
    });
  };
  const handleMouseUp = () => setIsDragging(false);

  const zoomIn = () => setScale(s => clampScale(s * 1.25));
  const zoomOut = () => {
    const next = clampScale(scale / 1.25);
    setScale(next);
    if (next <= fitScale + 1e-4) setOffset({ x: 0, y: 0 });
  };
  const zoomTo100 = () => { setScale(clampScale(1)); setOffset({ x: 0, y: 0 }); };
  const zoomFit = () => { setScale(fitScale); setOffset({ x: 0, y: 0 }); };

  const handleDownload = () => {
    if (!imageSrc) return;
    const link = document.createElement('a');
    link.href = imageSrc;
    link.download = `Preview_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen || !imageSrc) return null;

  const zoomPct = Math.round(scale * 100);
  const canPan = scale > fitScale + 1e-4;

  return (
    <div
      className="fixed inset-0 bg-black z-[100] flex flex-col animate-fade-in"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Top bar */}
      <div className="h-14 px-4 flex items-center justify-between bg-black/90 text-white z-[101] shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={zoomOut} className="p-2 hover:bg-white/20 rounded" title="축소"><MinusCircle className="w-5 h-5" /></button>
          <button onClick={zoomIn} className="p-2 hover:bg-white/20 rounded" title="확대"><PlusCircle className="w-5 h-5" /></button>
          <span className="text-sm font-bold min-w-[60px] text-center tabular-nums">{loaded ? zoomPct : 0}%</span>
          <button onClick={zoomFit} className="px-3 py-1 text-[11px] font-bold hover:bg-white/20 rounded border border-white/30">맞춤</button>
          <button onClick={zoomTo100} className="px-3 py-1 text-[11px] font-bold hover:bg-white/20 rounded border border-white/30">100%</button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleDownload} className="px-3 py-1.5 text-xs font-bold hover:bg-white/20 rounded border border-white/30 flex items-center gap-1" title="다운로드"><Download className="w-4 h-4" /> 다운로드</button>
          <button onClick={onClose} className="p-2 hover:bg-white/20 rounded" title="닫기"><X className="w-6 h-6" /></button>
        </div>
      </div>

      {/* Image viewport */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        style={{ cursor: canPan ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
      >
        <img
          src={imageSrc}
          alt="Full Screen Preview"
          onLoad={handleImgLoad}
          draggable={false}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: natural.w || 'auto',
            height: natural.h || 'auto',
            maxWidth: 'none',
            maxHeight: 'none',
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${loaded ? scale : 1})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.12s ease-out',
            visibility: loaded ? 'visible' : 'hidden',
            userSelect: 'none',
            willChange: 'transform',
          }}
        />
        {/* Helper hint */}
        {loaded && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[11px] font-bold px-3 py-1 rounded-full pointer-events-none">
            {canPan ? '드래그로 이동 · 휠로 확대/축소' : '휠로 확대 · 상단 버튼으로 100%까지 줌'}
          </div>
        )}
      </div>
    </div>
  );
};

const ReferenceDetailModal = ({ isOpen, onClose, reference, onSave, onDelete }) => {
  const [data, setData] = useState(reference || {});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { if (reference) setData(reference); setConfirmDelete(false); }, [reference]);

  if (!isOpen || !reference) return null;

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 lg:p-10">
      <div className="bg-white w-full max-w-4xl h-auto max-h-[90vh] flex flex-col md:flex-row overflow-hidden shadow-2xl animate-fade-in border-2 border-black">
        <div className="md:w-1/2 bg-gray-100 flex items-center justify-center relative border-r border-black p-4">
             <img src={data.image} className="max-w-full max-h-[60vh] object-contain shadow-md" alt="Reference" />
        </div>

        <div className="md:w-1/2 flex flex-col bg-white h-full overflow-hidden">
            <div className="p-6 border-b border-black flex justify-between items-center shrink-0">
                <div>
                    <h2 className="text-xl font-black uppercase tracking-tighter">Edit Reference</h2>
                    <p className="text-xs text-gray-500 font-bold uppercase">{new Date(data.createdAt?.seconds * 1000 || Date.now()).toLocaleDateString()}</p>
                </div>
                <button onClick={onClose} className="hover:bg-gray-100 p-2 rounded-full"><X className="w-6 h-6" /></button>
            </div>

            <div className="flex-1 p-6 flex flex-col gap-6 overflow-y-auto custom-scrollbar">
                <div>
                    <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">Brand</label>
                    <select value={data.brand || 'EZ'} onChange={e => setData({ ...data, brand: e.target.value })} className="w-full p-3 border border-black text-sm font-bold bg-white">
                        {FIXED_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">Style Name (Reference Title)</label>
                    <input type="text" value={data.name || ''} onChange={e => setData({ ...data, name: e.target.value })} className="w-full p-3 border border-black text-sm font-bold" />
                </div>
            </div>

            <div className="p-6 border-t border-black bg-gray-50 flex justify-between items-center shrink-0">
                {confirmDelete ? (
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-gray-800">정말 삭제할까요?</span>
                        <button onClick={() => onDelete(data.id)} className="px-3 py-2 bg-black text-white text-xs font-bold">확인</button>
                        <button onClick={() => setConfirmDelete(false)} className="px-3 py-2 bg-gray-200 text-black text-xs font-bold">취소</button>
                    </div>
                ) : (
                    <button onClick={() => setConfirmDelete(true)} className="text-black font-bold text-sm flex items-center gap-2 hover:bg-gray-200 px-4 py-3"><Trash2 className="w-4 h-4" /> Delete</button>
                )}
                <button onClick={() => onSave(data)} className="bg-black text-white px-8 py-3 font-bold uppercase hover:opacity-80 flex items-center gap-2"><Save className="w-4 h-4" /> Save</button>
            </div>
        </div>
      </div>
    </div>
  );
};

const LookbookHeader = ({ selectedBrand, onSelectBrand, onAddReference }) => {
    return (
        <div className="h-16 shrink-0 px-6 border-b border-black flex justify-between items-center bg-white">
            <div className="flex gap-4 overflow-x-auto custom-scrollbar">
                <button onClick={() => onSelectBrand('All')} className={`px-4 py-2 text-sm font-bold uppercase border ${selectedBrand === 'All' ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300'}`}>All Brands</button>
                {FIXED_BRANDS.map(b => ( <button key={b} onClick={() => onSelectBrand(b)} className={`px-4 py-2 text-sm font-bold uppercase border ${selectedBrand === b ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300'}`}>{b}</button> ))}
            </div>
            <button onClick={onAddReference} className="bg-black text-white px-5 py-2 text-sm font-bold hover:opacity-80 flex items-center gap-2 uppercase shrink-0"><Plus className="w-4 h-4" /> 레퍼런스 등록</button>
        </div>
    );
};

const LookbookDashboardGrid = ({ references, selectedBrand, onSelectReference, onDeleteReference, onEditReference }) => {
  const filtered = references.filter(r => selectedBrand === 'All' || r.brand === selectedBrand);

  return (
    <div className="w-full h-full flex flex-col bg-gray-50">
      <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-px bg-black border border-black">
          {filtered.map(r => (
            <div key={r.id} onClick={() => onSelectReference(r)} className="bg-white cursor-pointer group relative overflow-hidden hover:opacity-90 transition-opacity">
              <div className="aspect-[3/4] relative overflow-hidden bg-gray-100">
                <img src={r.image} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt="Reference" loading="lazy" />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  <div className="bg-white px-4 py-2 text-xs font-bold uppercase text-black">이 스타일로 생성하기</div>
                </div>
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); onEditReference(r); }} className="p-1.5 bg-white rounded-full text-black hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                    <button onClick={(e) => { e.stopPropagation(); onDeleteReference(r.id); }} className="p-1.5 bg-white rounded-full text-black hover:bg-gray-200"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-black/80 text-white px-3 py-1.5">
                  <p className="text-xs font-bold uppercase text-center">{r.brand}</p>
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (<div className="col-span-full py-20 text-center text-gray-400 font-bold uppercase">등록된 레퍼런스가 없습니다.</div>)}
        </div>
      </div>
    </div>
  );
};

const LookbookGenerator = ({ reference, references = [], onBack, settings, showNotification }) => {
  const [currentReference, setCurrentReference] = useState(reference);
  const [targetImage, setTargetImage] = useState(null);
  const [productDetailImages, setProductDetailImages] = useState([]); // 최대 3장 제품 디테일
  const [faceImages, setFaceImages] = useState([]); // 다중 얼굴 이미지 지원
  const [generatedImages, setGeneratedImages] = useState([]);
  const [currentImgIndex, setCurrentImgIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [prompt, setPrompt] = useState(reference.prompt || '');
  const [refineRequest, setRefineRequest] = useState('');
  const [isRefining, setIsRefining] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('3:4');
  const [targetFocus, setTargetFocus] = useState('upper'); // 'upper' (상의/전신) or 'lower' (하의/바지)
  const [showZoomModal, setShowZoomModal] = useState(false);
  const [selectedPhotographer, setSelectedPhotographer] = useState('');
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [swapBrandFilter, setSwapBrandFilter] = useState('All');

  const lookbookSnippets = [
    "이목구비 완벽 고정",
    "카메라를 의식하지 않는 시선",
    "바람에 살짝 날리는 잔머리",
    "긴장이 풀린 자연스러운 자세",
    "화장기가 옅은 투명한 피부",
    "인위적이지 않은 일상적인 빛",
    "보정 없는 RAW 사진 느낌",
    "스냅샷 같은 찰나의 순간"
  ];

  const photographerOptions = [
      { id: 'maria_svarbova', name: 'Maria Svarbova', desc: '파스텔,쿨톤,미니멀리즘,플랫 조명', style: 'Shot by Maria Svarbova, pastel colors, minimalist flat lighting, surreal atmosphere, precise facial features' },
      { id: 'nina_ahn', name: 'Nina Ahn', desc: '아날로그 필름', style: 'Shot by Nina Ahn, warm analog film photography, melancholic and dreamy mood, clear facial details' },
      { id: 'petra_collins', name: 'Petra Collins', desc: '소프트 포커스,몽환적', style: 'Shot by Petra Collins, feminine gaze, neon lighting, nostalgic soft focus, BUT keep face highly detailed and sharp' },
      { id: 'brooke_didonato', name: 'Brooke DiDonato', desc: '깨끗하고 고급스러운 조명', style: 'Shot by Brooke DiDonato, surrealism, Miniature-like effect,Exquisite and restrained lighting, MUST keep the face fully visible and highly detailed' },
      { id: 'nadia_lee_cohen', name: 'Nadia Lee Cohen', desc: '레트로 팝컬처. 샤픈, 키치', style: 'Shot by Nadia Lee Cohen, retro pop culture, kitsch, cinematic, vibrant colors, sharp facial features' },
      { id: 'elizaveta_porodina', name: 'Elizaveta Porodina', desc: '회화적 사진', style: 'Shot by Elizaveta Porodina, experimental lighting, Photo in painting style,ensure the face remains completely sharp and undistorted' }
  ];

  const handleTargetUpload = async (file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => { try { const img = await compressImage(r.result, 1024, 0.8); setTargetImage(img); } catch { /* ignore */ } };
    r.readAsDataURL(file);
  };

  const handleDetailUpload = async (files) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);
    const availableSlots = 3 - productDetailImages.length;
    const filesToProcess = newFiles.slice(0, availableSlots);

    for (const file of filesToProcess) {
      const r = new FileReader();
      r.onload = async () => {
        try {
          const img = await compressImage(r.result, 1024, 0.8);
          setProductDetailImages(prev => [...prev, img]);
        } catch { /* ignore */ }
      };
      r.readAsDataURL(file);
    }
  };

  const handleFaceUpload = async (files) => {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
        const r = new FileReader();
        r.onload = async () => {
            try {
                const img = await compressImage(r.result, 1024, 0.8);
                setFaceImages(prev => [...prev, img]);
            } catch { /* ignore */ }
        };
        r.readAsDataURL(file);
    });
  };

  const handleDownloadImage = () => {
      if (generatedImages.length === 0) return;
      const link = document.createElement('a');
      link.href = generatedImages[currentImgIndex];
      link.download = `Lookbook_Gen_${Date.now()}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  const generateDraftPrompt = async () => {
    if (!targetImage || !currentReference) return showNotification("의상/전신 타겟 이미지와 레퍼런스 이미지가 모두 필요합니다.", "error");
    setIsGeneratingPrompt(true);
    try {
      const apiKeyToUse = settings?.apiKey || DEFAULT_API_KEY;

      const compRef = await compressImage(currentReference.image, 1024, 0.8);
      const compTarget = await compressImage(targetImage, 1024, 0.8);

      const parts = [
        { text: `
          You are a professional Creative Director for a high-end fashion brand.

          YOUR TASK:
          1. Analyze the [Reference Image] for its art direction: lighting, color palette, mood, and background.
          2. Analyze the [Target Image] with **EXTREME PRECISION** for the Subject's body and Clothing.
          ${productDetailImages.length > 0 ? '3. Analyze the [Product Detail Images] to extract exact fabric texture, material, and stitching details.' : ''}
          ${faceImages.length > 0 ? '4. Analyze the [Face Image] as the ABSOLUTE source of truth for the facial identity and micro-proportions.' : ''}

          CRITICAL ANALYSIS POINTS:
          ${faceImages.length > 0 ? '- **FACE & IDENTITY**: Analyze specific eye shape, nose bridge, lip fullness, jawline, skin texture, and hair flow strictly based on the **[Face Image]** with extreme micro-precision.' : '- **FACE & IDENTITY**: Analyze specific eye shape, nose bridge, lip fullness, jawline, skin texture, and hair flow based on [Target Image].'}
          - **CLOTHING DETAILS**: Analyze fabric texture, exact silhouette, stitching details, and how the fabric drapes based on ${productDetailImages.length > 0 ? '[Target Image] AND [Product Detail Images]' : '[Target Image]'}.

          OUTPUT GOAL:
          Write a detailed image generation prompt in **KOREAN (한국어)**.

          **CRITICAL**: The prompt MUST START with the following IDENTITY LOCK instruction (copy exactly):
          ---
          [아이덴티티 고정 지시]
          - 반드시 ${faceImages.length > 0 ? '얼굴 전용 타겟 이미지' : '타겟 이미지'}의 인물을 그대로 사용할 것
          - 얼굴 특징(눈, 코, 입 비율 및 형태), 턱선, 피부톤 100% 보존
          - 헤어스타일 및 머리카락 질감 그대로 유지
          - 새로운 인물 생성 절대 금지, 소스 이미지의 인물과 완벽히 일치해야 함
          ---

          Then, structure the rest of the prompt into these categories:
          1. **전체 분위기 (Mood)**: Based on [Reference Image].
          2. **배경 (Background)**: Based on [Reference Image].
          3. **포즈 (Pose)**: Natural pose fitting the mood.
          4. **라이팅 및 톤 (Lighting)**: Based on [Reference Image].
          5. **카메라 세팅 (Camera)**: High-end fashion photography settings.
          6. **후보정 (Post-processing)**: Retouching style, color grading, high-end finishing.

          FORMAT:
          Return the Korean prompt text starting with the identity lock instruction, then organized by categories. Do not add introductions. Do NOT include descriptions of the model's identity, face, or clothing in the text prompt, as they are locked by the image references.
        ` },
        { inlineData: { mimeType: "image/jpeg", data: compRef.split(',')[1] } },
        { inlineData: { mimeType: "image/jpeg", data: compTarget.split(',')[1] } }
      ];

      for (const detailImg of productDetailImages) {
          const compDetail = await compressImage(detailImg, 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compDetail.split(',')[1] } });
      }

      if (faceImages.length > 0) {
          const compFace = await compressImage(faceImages[0], 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compFace.split(',')[1] } });
      }

      const response = await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL_ID}:generateContent?key=${apiKeyToUse}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }] })
        }
      );

      const data = await response.json();
      if (data.error) throw new Error(`API Error: ${data.error.message}`);

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        setPrompt(text.trim());
        showNotification(faceImages.length > 0 ? "얼굴 이미지 기반 이목구비 고정 프롬프트가 생성되었습니다." : "이목구비 고정 지시가 포함된 프롬프트가 생성되었습니다.");
      } else {
        throw new Error("프롬프트 생성 실패: 응답에 텍스트가 없습니다.");
      }
    } catch (e) {
      showNotification("프롬프트 생성 오류: " + String(e.message || e), "error");
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  const handleRefinePrompt = async () => {
    if (!prompt || !refineRequest) return;
    setIsRefining(true);
    try {
        const apiKeyToUse = settings?.apiKey || DEFAULT_API_KEY;
        const response = await fetchWithRetry(`https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL_ID}:generateContent?key=${apiKeyToUse}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `Original: ${prompt}\nRequest: ${refineRequest}\nTask: Modify prompt based on request. Return ONLY the Korean prompt.` }] }] }) });
        const data = await response.json(); const text = data.candidates?.[0]?.content?.parts?.[0]?.text; if (text) { setPrompt(text.trim()); setRefineRequest(''); }
    } catch { showNotification("수정 실패", "error"); } finally { setIsRefining(false); }
  };

  const handleGenerate = async () => {
    if (!targetImage) return showNotification("적용할 대상(제품/모델 전신) 이미지를 업로드해주세요.", "error");
    if (!prompt) return showNotification("프롬프트를 먼저 입력하거나 생성해주세요.", "error");

    setIsGenerating(true);
    try {
      const compTarget = await compressImage(targetImage, 1024, 0.8);
      const compRef = await compressImage(currentReference.image, 1024, 0.8);

      let inputImagesText = `
    [IMAGE INPUTS RECOGNITION]
    Image 1 (Target Subject): Source for TARGET BODY & EXACT CLOTHES.
    Image 2 (Reference Style): Source for ENVIRONMENT, LIGHTING & MOOD.`;

      let clothesRuleText = `
    [RULE 1: TARGET CLOTHING & BODY (ABSOLUTE LOCK)]
    - SOURCE: Image 1 (Target Subject)
    - MANDATORY: You MUST dress the subject in the exact outfit shown in Image 1. Copy the fabric, fit, styling, and silhouette perfectly.
    - PROHIBITED: NEVER use the clothing from Image 2. The outfit in Image 2 is strictly forbidden and MUST NOT appear in the final image.`;

      let styleRuleText = `
    [RULE 2: STYLE & ENVIRONMENT TRANSFER (ABSOLUTE SCENE LOCK)]
    - SOURCE: Image 2 (Reference Style)
    - MANDATORY: Change the background, lighting, and color grading to match Image 2 perfectly. Extract the atmosphere and lighting.
    - ENVIRONMENTAL LOCK: The background scene, lighting direction, shadows, and overall atmosphere MUST be perfectly locked and identical across all generated images. Do not alter the environment.
    - PROHIBITED: Do not bring the person or outfit from Image 2 into the new image. Ignore ALL text, typography, logos, or collages from Image 2.`;

      let faceRuleText = ``;
      let currentImgIdx = 3;

      if (productDetailImages.length > 0) {
          inputImagesText += `\n    Image ${currentImgIdx} to ${currentImgIdx + productDetailImages.length - 1} (Detail Images): Source for CLOTHING MICRO-TEXTURE.`;
          clothesRuleText += `\n    - TEXTURE LOCK: Use these detail images to perfectly replicate the fabric weave and stitching of the outfit.`;
          currentImgIdx += productDetailImages.length;
      }

      if (faceImages.length > 0) {
          inputImagesText += `\n    Image ${currentImgIdx}+ (Face Detail Images): Source for TARGET FACE (Facial features).`;
          faceRuleText = `
    [RULE 3: TARGET FACE LOCK — #1 ABSOLUTE NON-NEGOTIABLE PRIORITY]
    - SOURCE OF TRUTH: Image ${currentImgIdx}+ (Face Detail Images). These face images are the SINGLE SOURCE OF TRUTH for the model's identity and override every other input for facial features.
    - 100% IDENTITY MATCH REQUIRED whenever the face is visible at any size in the frame:
      * Eye shape, eye spacing (canthal tilt), iris color and pattern, eyelid fold structure
      * Nose bridge length/width, nostril shape, nose tip
      * Lip shape, philtrum, mouth corner angle, teeth visibility/shape
      * Jawline angle, chin shape, cheekbone height, ear shape
      * Eyebrow shape, density, and natural growth direction
      * Skin tone (exact hue/value), freckles, moles, scars, birthmarks — copy ALL of them in their exact positions
      * Hairline, hair color, hair texture, parting direction, exact hairstyle volume
    - INTERPOLATION PROHIBITED: Do NOT "average", "beautify", "smooth", "westernize/easternize", or stylize the face. The model's micro-asymmetries and imperfections MUST be preserved verbatim — they are part of the identity.
    - NO NEW FACE: Generating a different person, a different ethnicity, or a different age is a hard failure.
    - CONSISTENCY ACROSS VARIATIONS: All 4 generated images MUST show the SAME EXACT PERSON. Any drift between variations is a hard failure.`;
      } else {
          faceRuleText = `
    [RULE 3: TARGET FACE LOCK — #1 ABSOLUTE NON-NEGOTIABLE PRIORITY]
    - SOURCE OF TRUTH: Image 1 (Target Subject). The face shown in Image 1 is the SINGLE SOURCE OF TRUTH for the model's identity.
    - 100% IDENTITY MATCH REQUIRED whenever the face is visible at any size in the frame:
      * Eye shape, eye spacing, iris pattern, eyelid fold
      * Nose bridge, nostril shape, nose tip
      * Lip shape, philtrum, mouth corners
      * Jawline, chin, cheekbones, ears
      * Eyebrow shape and density
      * Skin tone (exact hue/value), freckles/moles/scars/birthmarks at their exact positions
      * Hairline, hair color, hair texture, parting, exact hairstyle volume
    - INTERPOLATION PROHIBITED: Do NOT "average", "beautify", "smooth", or stylize the face. Preserve micro-asymmetries verbatim.
    - NO NEW FACE: Generating a different person, ethnicity, or age is a hard failure.
    - CONSISTENCY ACROSS VARIATIONS: All 4 generated images MUST show the SAME EXACT PERSON.`;
      }

      let photoStyleDesc = "";
      if (selectedPhotographer) {
          const selected = photographerOptions.find(p => p.id === selectedPhotographer);
          if (selected) {
              photoStyleDesc = `\n[POST-PROCESSING & COLOR GRADING]\n- Apply the color grading, film texture, and retouching style of: ${selected.style}\n- CRITICAL: Apply this ONLY as a final post-processing filter. Do NOT alter the underlying facial identity, composition, or structural lighting.`;
          }
      }

      const parts = [
        { text: `
    TASK: High-End Fashion Lookbook Generation with ABSOLUTE PILLAR LOCKING.

    =========================================
    #1 ABSOLUTE NON-NEGOTIABLE PRIORITIES (override everything else)
    =========================================
    PRIORITY A — FACIAL IDENTITY PRESERVATION:
      The model's face must be 100% IDENTICAL to the source face image, with no "drift", "averaging", "beautifying", or stylization. Eye shape / nose / lips / jawline / skin tone / hairline / micro-features (freckles, moles, scars) must all be preserved verbatim. If the face wobbles or changes between the 4 variations, the entire output is a failure. See RULE 3 for the full identity lock spec.

    PRIORITY B — HYPER-REALISTIC PHOTOREALISM (NOT AI-LOOKING):
      The output MUST read as a high-resolution real photograph — NOT digital art, NOT AI render, NOT illustration, NOT CGI.
      - Crisp focus on the subject; sharp eyes (catchlights visible); naturally rendered skin pores, peach fuzz, micro-pigmentation, and subtle subsurface scattering
      - Natural film grain and organic color rendering at high resolution; NO plastic skin, NO over-smoothing, NO waxy highlights, NO uncanny symmetry
      - Authentic lens characteristics: realistic depth of field, natural bokeh, accurate light fall-off, lens flare/aberration ONLY where physically appropriate
      - Fabric must show real macro-level weave/knit/grain with believable thread tension, NOT melted or smoothed surfaces
      - Avoid all "AI tells": symmetrical earrings that don't match, fingers fused or with wrong counts, floating jewelry, broken text, melted seams, glitched logos
      - Resolution & quality: ultra-sharp 4K-equivalent detail end-to-end, with no soft/blurry passes on the face

    PRIORITY C — FACE-SIZE GUARANTEE (prevents identity drift in distant shots):
      The face MUST always occupy enough pixels to render identity correctly. If the requested framing would shrink the face below ~6% of the frame height (i.e. tiny in the distance), tighten the camera so the face area is sufficient. NEVER place the model so far away that the face becomes a smudge of pixels — pull the camera in until the face has detail. This rule overrides camera-distance instructions in any single variation.

    PRIORITY D — PERSPECTIVE GUARD (prevents face distortion at extreme angles):
      Low-angle and high-angle shots must use MODERATE tilt (no more than ~15-20° from horizontal). NEVER apply extreme foreshortening that would distort the chin, forehead, or facial proportions. Lens choice should be standard portrait equivalent (50-85mm full-frame look) — avoid wide-angle distortion on the face.

    PRIORITY E — 4-IMAGE SCENE CONSISTENCY (HARD ENVIRONMENTAL LOCK ACROSS ALL 4 OUTPUTS):
      All 4 generated images MUST look like they were shot in the SAME continuous photo session, in the SAME location, at the SAME moment in time. Treat them as 4 frames captured back-to-back from a single fixed setup — only the camera angle/pose changes, NOTHING ELSE.
      The following variables MUST be MATHEMATICALLY IDENTICAL across all 4 outputs:
      - LOCATION & BACKGROUND: same exact room/scene/landscape, same wall textures, same furniture placement, same props in identical positions, same floor, same ceiling, same horizon line. No new objects appear or disappear between variations.
      - LIGHTING SETUP: same key light direction, same key light intensity, same key light color temperature (Kelvin), same fill light, same rim/back light if any. Light source positions are FIXED.
      - SHADOWS: same shadow direction, same shadow softness/hardness, same shadow density. Shadows shift only because the subject's pose changed — never because the lights moved.
      - TIME-OF-DAY & ATMOSPHERE: same sun position (if outdoor), same window light angle (if indoor), same atmospheric haze/dust/weather, same ambient color cast.
      - COLOR GRADING & TONE: same white balance, same exposure, same contrast, same saturation, same film grain character, same color science.
      - LENS & CAMERA BODY: same lens family / focal length character, same depth of field aesthetic, same sensor look.
      - WARDROBE: identical outfit on the model in all 4 frames — no changes to clothing, accessories, hair styling, or makeup.
      ANY drift in lighting, location, props, weather, time-of-day, color grade, wardrobe, or styling between the 4 outputs is a HARD FAILURE.

      CAMERA POSITION VARIETY (REQUIRED DIFFERENCE):
      The PHOTOGRAPHER'S physical camera position MUST be visibly different in each of the 4 images — never duplicate the same camera placement across variations. Each variation captures the same fixed scene from a clearly distinct viewpoint (different distance, different height, and/or different horizontal/vertical angle relative to the subject and the locked environment). Two variations sharing the same camera placement is a HARD FAILURE. The scene/lights are locked; the photographer moves.

      POSE & EXPRESSION VARIETY (REQUIRED SUBSTANTIAL DIFFERENCE):
      The model's pose and facial expression MUST be SUBSTANTIALLY DIFFERENT in each of the 4 images — NOT subtle micro-variations. Each variation should pick a clearly distinct combination of:
      - BODY POSTURE: standing tall / weight on one leg / leaning / walking / turning / crouching / hands on hips / arms crossed / one arm raised / hand in pocket / hand through hair (pick a distinctly different posture per variation)
      - WEIGHT DISTRIBUTION: shift weight to left leg / right leg / both feet / forward / back
      - ARM & HAND PLACEMENT: relaxed at sides / one hand on hip / both hands in pockets / one hand touching face or hair / arms crossed / one arm raised / holding the garment edge — choose distinctly different positions
      - HEAD & GAZE: straight at camera / 3/4 turn / profile / looking down / looking up / looking off-frame
      - FACIAL EXPRESSION: neutral / soft smile / pensive / intense / playful / serene — pick a clearly different expression for each variation, never duplicate
      CONSTRAINT — OUTFIT VISIBILITY: every pose MUST still showcase the outfit cleanly. Do NOT obscure the main garment with extreme contortions, do NOT cross arms in a way that hides the chest of a top, do NOT cover the hemline with hands, do NOT crop the garment with body language. The outfit's silhouette and key details must remain readable in every pose.
      Two variations sharing essentially the same pose or essentially the same expression is a HARD FAILURE.

    ${inputImagesText}

    =========================================
    THE THREE PILLARS OF GENERATION
    =========================================
    ${clothesRuleText}
    ${styleRuleText}
    ${faceRuleText}

    =========================================
    USER'S CREATIVE DIRECTION & PHOTOGRAPHER STYLE
    =========================================
    ${prompt}
    ${photoStyleDesc}

    ${HIGH_END_STYLE_PROMPT}
        ` },
        { inlineData: { mimeType: "image/jpeg", data: compTarget.split(',')[1] } }, // Target Body First
        { inlineData: { mimeType: "image/jpeg", data: compRef.split(',')[1] } }     // Reference Style Second
      ];

      for (const detailImg of productDetailImages) {
          const compDetail = await compressImage(detailImg, 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compDetail.split(',')[1] } });
      }

      for (const faceImg of faceImages) {
          const compFace = await compressImage(faceImg, 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compFace.split(',')[1] } });
      }

      let var3Desc = "Variation 3: Waist-up medium shot (framing from the waist line up to the top of the head) in the EXACT SAME lighting and background environment. The camera is at chest-to-eye level. The frame MUST cut off precisely at the waistline — do NOT zoom in closer than the waist, and do NOT include the legs. This shows both the face and upper body styling naturally.";

      const var4UpperPool = [
          "Slight low-angle MEDIUM shot — camera positioned at chest level (slightly below) with a MODEST upward tilt (around 10-15° from horizontal, NOT extreme). Framed from the waist up to the top of the head (medium shot, NOT full body). Use a standard portrait lens equivalent (50-85mm) so the face proportions are NEVER distorted by wide-angle foreshortening. The upward angle creates a subtle, editorial perspective.",
          "Slight high-angle MEDIUM shot — camera positioned just above the subject's eye level with a MODEST downward tilt (around 10-15° from horizontal, NOT extreme). Framed from the waist up to the top of the head (medium shot, NOT full body). Use a standard portrait lens equivalent (50-85mm) so the face proportions are NEVER distorted. The downward angle creates a subtle, intimate perspective."
      ];
      let var4Desc = `Variation 4: ${var4UpperPool[Math.floor(Math.random() * var4UpperPool.length)]} The lighting and background MUST be 100% identical to the reference. The face MUST remain undistorted and recognizable.`;

      if (targetFocus === 'lower') {
          var3Desc = "Variation 3: Lower body close-up shot (waist down to ankles) in the EXACT SAME lighting and background environment. The camera is at waist or thigh level, focusing explicitly on the pants, skirt, and lower body garment details.";
          var4Desc = "Variation 4: Walking-motion candid lower body shot — the subject captured mid-stride from a slight 3/4 angle, showing natural movement and flow of the fabric on the legs. Camera at waist-to-thigh level, framing waist down to ankles. The lighting and background MUST be 100% identical to the reference.";
      }

      const lookbookVariations = [
          "Variation 1: Match the EXACT framing, composition, distance, and camera angle of the Reference Style Image (Image 2). Replicate the original perspective perfectly. The lighting and background MUST be 100% identical to the reference.",
          "Variation 2: Wide shot — the full body of the subject is comfortably visible with moderate negative space around the figure (NOT an extreme wide shot, NOT environmental scale). The subject must occupy enough of the frame that the face remains clearly detailed and recognizable — face area MUST be large enough to preserve identity (at minimum the face should occupy ~6-8% of the frame height, equivalent to a standard full-body fashion shot, not a tiny figure in a landscape). The lighting and background MUST be 100% identical to the reference; only the camera distance changes (slightly further than Variation 1, but keep the face crisp).",
          var3Desc,
          var4Desc
      ];

      const promises = lookbookVariations.map((variationDesc, i) => {
          return new Promise(async (resolve, reject) => {
              try {
                  await delay(i * 1500); // API Rate Limit 방지를 위한 지연
                  const localParts = [...parts];
                  localParts[0] = { text: localParts[0].text + `\n\n[CAMERA & FRAMING (FOR THIS SPECIFIC VARIATION)]\nEnsure this generation strictly follows this camera angle and framing: [${variationDesc}].\n\n[HARD SCENE LOCK — IDENTICAL ACROSS ALL 4 OUTPUTS]\nThis is variation ${i + 1} of 4 from the SAME continuous photo session. The other 3 variations share the SAME location, SAME light setup, SAME props, SAME wardrobe, SAME time-of-day, SAME color grade, SAME atmosphere. The ONLY thing that changes between variations is the photographer's camera position / framing distance / and the subject's pose. EVERYTHING ELSE is mathematically identical:\n- Background scene, walls, floor, ceiling, props, furniture: pixel-locked to the reference\n- Key light direction & intensity, fill light, rim light: pixel-locked\n- Shadow direction, softness, density: identical (only the subject's body shape moves shadows naturally)\n- Time of day, sun position, atmospheric haze: identical\n- White balance, exposure, contrast, saturation, film grain: identical\n- Outfit, accessories, hair, makeup: identical\nDo NOT introduce any new objects, do NOT shift the light, do NOT change the wall texture or color, do NOT alter the wardrobe.\n\n[CAMERA POSITION — MUST BE VISIBLY DIFFERENT FROM THE OTHER 3 VARIATIONS]\nThe photographer is physically standing at a different location for variation ${i + 1} than for the other variations. The viewpoint (distance / height / horizontal-and-vertical angle relative to the locked scene) MUST be clearly distinct from variations ${[1, 2, 3, 4].filter(n => n !== i + 1).join(', ')}. Never duplicate another variation's camera placement.\n\n[POSE & EXPRESSION — SUBSTANTIALLY DIFFERENT FROM OTHER VARIATIONS]\nVariation ${i + 1}'s body posture, weight distribution, arm/hand placement, head angle, gaze direction, AND facial expression MUST all be distinctly different from variations ${[1, 2, 3, 4].filter(n => n !== i + 1).join(', ')}. Pick a unique pose category for this variation (e.g. weight on one leg with hand on hip / leaning forward with arms crossed / mid-stride walk / hand through hair / contemplative profile gaze, etc.) and a unique expression (neutral / soft smile / pensive / intense / playful — never duplicate). The variations must read as 4 visibly different moments in the session, not 4 minor takes of the same pose.\nCRITICAL CONSTRAINT: every pose MUST still showcase the outfit clearly — keep the garment's silhouette, key details, and hemline visible. Do NOT cover the garment with crossed arms, do NOT obscure the chest/torso, do NOT crop key details with body language.\n\nSTRICTLY adhere to the Three Pillars and all 5 absolute priorities.` };

                  const { dataUrl } = await geminiGenerateImage({
                    primaryModelId: settings.modelId || MODEL_OPTIONS.PRO,
                    fallbackModelId: null,
                    apiKey: settings.apiKey || DEFAULT_API_KEY,
                    contentsParts: localParts,
                    aspectRatio,
                    qualityMode: settings.highRes ? 'ultra' : 'std'
                  });
                  resolve(dataUrl);
              } catch (e) {
                  reject(e);
              }
          });
      });

      const results = await Promise.allSettled(promises);
      const successfulImages = results.filter(r => r.status === 'fulfilled').map(r => r.value);

      if (successfulImages.length === 0) {
          const error = results.find(r => r.status === 'rejected')?.reason;
          throw error || new Error("이미지 생성에 실패했습니다.");
      }

      setGeneratedImages(successfulImages);
      setCurrentImgIndex(0);

      if (successfulImages.length < 4) {
          showNotification(`4장 중 ${successfulImages.length}장만 생성되었습니다.`);
      } else {
          showNotification("4장의 화보컷이 성공적으로 생성되었습니다.");
      }

    } catch(e) { showNotification(String(e.message || e), 'error'); }
    finally { setIsGenerating(false); }
  };

  return (
    <div className="flex flex-row h-full bg-white relative">
      <div className="flex-1 flex flex-col p-8 overflow-y-auto bg-gray-50">
        <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6 h-full">

          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-black text-white px-3 py-1 text-sm font-bold uppercase">STYLE BASE</span>
              <span className="text-sm font-bold uppercase truncate flex-1">{currentReference.name}</span>
              <button onClick={() => setShowSwapModal(true)} className="text-[11px] font-bold uppercase bg-white text-black px-3 py-1.5 border border-black hover:bg-black hover:text-white flex items-center gap-1 transition-colors shrink-0" title="레퍼런스 교체">
                <RefreshCcw className="w-3 h-3" /> 교체
              </button>
            </div>
            <div className="flex-1 border border-black bg-white p-2 relative min-h-[400px] group cursor-pointer" onClick={() => setShowSwapModal(true)}>
              <img src={currentReference.image} className="w-full h-full object-contain" alt="Style Reference" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none">
                <div className="bg-white px-4 py-2 text-xs font-bold uppercase text-black flex items-center gap-1"><RefreshCcw className="w-3 h-3" /> 클릭하여 교체</div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 mb-2">
                <div className="flex items-center gap-2"><span className="bg-black text-white px-3 py-1 text-sm font-bold uppercase">TARGET (Body & Clothes)</span></div>
                <span className="text-[11px] text-gray-500 font-bold uppercase">의상과 전신 실루엣 기준 (필수)</span>
            </div>
            <div onClick={() => document.getElementById('target-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleTargetUpload(e.dataTransfer.files[0]); }} className="flex-1 border-2 border-dashed border-gray-400 bg-white hover:border-black cursor-pointer flex items-center justify-center relative min-h-[300px] overflow-hidden">
              {targetImage ? (<img src={targetImage} className="w-full h-full object-contain" alt="Target" />) : (<div className="text-center p-8 text-gray-400"><UploadCloud className="w-12 h-12 mx-auto mb-4" /><p className="font-bold text-sm">의상/전신 이미지 업로드</p></div>)}
              <input id="target-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleTargetUpload(e.target.files[0])} />
            </div>

            <div className="flex gap-2 mt-1 mb-1">
                <button onClick={() => setTargetFocus('upper')} className={`flex-1 py-2 text-[11px] font-bold uppercase transition-colors border ${targetFocus === 'upper' ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'}`}>상의/전신 포커스</button>
                <button onClick={() => setTargetFocus('lower')} className={`flex-1 py-2 text-[11px] font-bold uppercase transition-colors border ${targetFocus === 'lower' ? 'bg-black text-white border-black' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'}`}>하의 포커스 (하반신)</button>
            </div>

            <div className="flex flex-col gap-1 mt-1 mb-1">
                <div className="flex items-center gap-2"><span className="bg-gray-200 text-black px-3 py-1 text-sm font-bold uppercase">PRODUCT DETAILS (선택)</span></div>
                <span className="text-[11px] text-gray-500 font-bold uppercase">원단 질감, 재봉선 등 디테일 컷 (최대 3장)</span>
            </div>
            <div className="flex gap-2 items-start bg-white border border-gray-300 p-2 min-h-[80px]">
               {productDetailImages.map((img, idx) => (
                  <div key={idx} className="relative w-16 h-16 border border-gray-300 shrink-0 bg-white">
                     <img src={img} className="w-full h-full object-cover" alt={`Detail ${idx+1}`} />
                     <button onClick={() => setProductDetailImages(prev => prev.filter((_, i) => i !== idx))} className="absolute -top-1.5 -right-1.5 bg-black rounded-full text-white p-0.5 hover:bg-gray-800"><X className="w-3 h-3"/></button>
                  </div>
               ))}
               {productDetailImages.length < 3 && (
                  <div onClick={() => document.getElementById('lookbook-detail-upload').click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleDetailUpload(e.dataTransfer.files); }} className="w-16 h-16 border-2 border-dashed border-gray-300 bg-gray-50 cursor-pointer flex flex-col items-center justify-center shrink-0 hover:border-black transition-colors">
                     <Plus className="w-4 h-4 text-gray-400 mb-0.5"/>
                     <span className="text-[8px] font-bold text-gray-500 text-center leading-tight">디테일<br/>추가</span>
                     <input id="lookbook-detail-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleDetailUpload(e.target.files)} />
                  </div>
               )}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 mb-2">
                <div className="flex items-center gap-2"><span className="bg-gray-800 text-white px-3 py-1 text-sm font-bold uppercase">TARGET (Face Detail)</span></div>
                <span className="text-[11px] text-gray-500 font-bold uppercase">이목구비 일관성을 위한 다각도 얼굴 사진 (다중 선택 가능)</span>
            </div>

            {faceImages.length > 0 ? (
                <div className="flex-1 flex flex-col gap-2 border-2 border-dashed border-gray-400 bg-white p-2 min-h-[400px]">
                    <div className="flex-1 w-full h-full relative border border-gray-200">
                        <img src={faceImages[0]} className="w-full h-full object-contain absolute inset-0" alt="Primary Face" />
                        <button onClick={() => setFaceImages(prev => prev.slice(1))} className="absolute top-2 right-2 p-1.5 bg-black text-white rounded-full hover:bg-gray-800 z-10"><X className="w-4 h-4"/></button>
                    </div>
                    {faceImages.length > 1 && (
                        <div className="flex gap-2 overflow-x-auto py-1 shrink-0 h-24 custom-scrollbar">
                            {faceImages.slice(1).map((img, idx) => (
                                <div key={idx+1} className="w-20 h-full shrink-0 relative border border-gray-200">
                                    <img src={img} className="w-full h-full object-cover" alt={`Face ${idx+2}`}/>
                                    <button onClick={() => setFaceImages(prev => prev.filter((_, i) => i !== idx + 1))} className="absolute top-1 right-1 p-1 bg-black text-white rounded-full hover:bg-gray-800"><X className="w-3 h-3"/></button>
                                </div>
                            ))}
                        </div>
                    )}
                    <button onClick={() => document.getElementById('face-upload').click()} className="w-full py-2 bg-gray-100 text-black border border-gray-300 text-xs font-bold flex items-center justify-center gap-1 hover:bg-gray-200 transition-colors"><Plus className="w-4 h-4"/> 사진 추가하기 ({faceImages.length}장)</button>
                    <input id="face-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleFaceUpload(e.target.files)} />
                </div>
            ) : (
                <div onClick={() => document.getElementById('face-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFaceUpload(e.dataTransfer.files); }} className="flex-1 border-2 border-dashed border-gray-400 bg-white hover:border-black cursor-pointer flex items-center justify-center relative min-h-[400px] overflow-hidden">
                    <div className="text-center p-8 text-gray-400"><UserCheck className="w-12 h-12 mx-auto mb-4" /><p className="font-bold text-sm">얼굴/디테일 다중 업로드</p><p className="text-[10px] mt-1">이목구비를 완벽히 카피합니다.</p></div>
                    <input id="face-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleFaceUpload(e.target.files)} />
                </div>
            )}
          </div>
        </div>
      </div>

      <div className="w-1/2 bg-white border-l border-black flex flex-col z-20 shadow-xl shrink-0 h-full">
        <div className="h-16 px-6 border-b border-black flex items-center justify-between shrink-0">
            <h2 className="text-xl font-black uppercase">Generator</h2>
            <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 custom-scrollbar">

          {generatedImages.length > 0 && (
            <div className="flex flex-col gap-4 animate-fade-in border-b-2 border-black pb-8 mb-2">
              <div className="flex items-center gap-2 mb-1"><CheckCircle2 className="w-5 h-5 text-black" /><span className="text-sm font-bold uppercase text-black">Generation Complete ({currentImgIndex + 1}/{generatedImages.length})</span></div>
              <div className="aspect-[3/4] border border-black bg-gray-100 relative group">
                <img src={generatedImages[currentImgIndex]} className="w-full h-full object-cover cursor-pointer" onClick={() => setShowZoomModal(true)} alt="Generated" />
                <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity pointer-events-none"><Maximize2 className="w-8 h-8 text-white drop-shadow-md" /></div>
                <button onClick={(e) => { e.stopPropagation(); handleDownloadImage(); }} title="다운로드" className="absolute top-3 right-3 z-20 bg-white/95 hover:bg-white border border-black p-2 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"><Download className="w-4 h-4 text-black" /></button>

                {generatedImages.length > 1 && (
                  <>
                    <button onClick={(e) => { e.stopPropagation(); setCurrentImgIndex(p => Math.max(0, p - 1)); }} disabled={currentImgIndex === 0} className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 hover:bg-white text-black rounded-full disabled:opacity-30 z-10 shadow-md">
                      <ChevronLeft className="w-6 h-6" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setCurrentImgIndex(p => Math.min(generatedImages.length - 1, p + 1)); }} disabled={currentImgIndex === generatedImages.length - 1} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 hover:bg-white text-black rounded-full disabled:opacity-30 z-10 shadow-md">
                      <ChevronRight className="w-6 h-6" />
                    </button>
                    <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-2 z-10">
                       {generatedImages.map((_, i) => (
                          <div key={i} className={`w-2 h-2 rounded-full ${i === currentImgIndex ? 'bg-black shadow-[0_0_2px_white]' : 'bg-gray-400 shadow-[0_0_2px_black]'}`} />
                       ))}
                    </div>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                 <button onClick={handleDownloadImage} className="w-full bg-black text-white px-4 py-3 text-sm font-bold uppercase hover:bg-gray-800 flex items-center justify-center gap-2" title="현재 이미지 다운로드"><Download className="w-4 h-4" /> 다운로드 (로컬 저장)</button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-6">
            <div>
                <div className="flex justify-between items-end mb-2">
                    <label className="text-sm font-bold uppercase text-gray-800 block">프롬프트 (Prompt)</label>
                    <button onClick={generateDraftPrompt} disabled={isGeneratingPrompt || !targetImage} className="text-[11px] font-bold uppercase bg-white text-black px-3 py-1.5 border border-black hover:bg-gray-100 flex items-center gap-1 transition-colors">
                        {isGeneratingPrompt ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
                        {prompt ? '이목구비 고정 강화 재생성' : 'AI 프롬프트 초안 생성'}
                    </button>
                </div>

                <div className="flex flex-col gap-1.5 mb-2 border p-2 bg-gray-50/50">
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-[10px] font-bold text-gray-400 w-12 shrink-0 uppercase tracking-wider">스타일</span>
                    {lookbookSnippets.map(s => (
                      <button key={s} onClick={() => appendPromptSnippet(s, setPrompt)} className="text-[11px] font-bold px-2 py-1 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 transition-colors">
                        + {s}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea value={prompt || ''} onChange={(e) => setPrompt(e.target.value)} className="w-full h-32 p-3 border border-black text-sm focus:outline-none bg-gray-50 font-medium leading-relaxed" placeholder="여기에 지시사항을 입력하세요..." />
            </div>

            <div className="flex flex-col gap-2 border-t border-dashed border-gray-300 pt-4 mt-[-8px]">
                <span className="text-xs font-bold uppercase text-gray-500 flex items-center gap-1"><MessageSquarePlus className="w-4 h-4"/> AI Assistance</span>
                <div className="flex gap-2">
                    <input type="text" value={refineRequest} onChange={(e) => setRefineRequest(e.target.value)} placeholder="수정 요청 (예: 배경을 더 밝게...)" className="flex-1 p-3 border border-gray-300 text-sm focus:border-black outline-none bg-white" onKeyDown={(e) => e.key === 'Enter' && handleRefinePrompt()} />
                    <button onClick={handleRefinePrompt} disabled={isRefining || !refineRequest} className="px-5 bg-gray-100 border border-gray-300 hover:bg-gray-200 text-sm font-bold transition-colors">
                        {isRefining ? <Loader2 className="w-4 h-4 animate-spin" /> : '수정'}
                    </button>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <label className="text-sm font-bold uppercase text-gray-800">Image Ratio</label>
                <div className="flex gap-2">
                    {['3:4', '1:1', '16:9'].map(ratio => (
                        <button key={ratio} onClick={() => setAspectRatio(ratio)} className={`flex-1 py-3 text-sm font-bold uppercase border ${aspectRatio === ratio ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300 hover:bg-gray-50'}`}>
                            {ratio === '3:4' ? <Smartphone className="w-4 h-4 mx-auto" /> : ratio === '1:1' ? <div className="w-4 h-4 border-2 border-current mx-auto" /> : <Monitor className="w-4 h-4 mx-auto" />}
                            <span className="mt-2 block">{ratio}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-2 mb-2 mt-2">
                <label className="text-sm font-bold uppercase text-gray-800 flex items-center gap-1"><Camera className="w-4 h-4"/> 포토그래퍼 스타일 (선택)</label>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                    {photographerOptions.map(p => (
                        <button
                            key={p.id}
                            onClick={() => setSelectedPhotographer(selectedPhotographer === p.id ? '' : p.id)}
                            className={`p-2.5 text-left border transition-all flex flex-col gap-1 ${selectedPhotographer === p.id ? 'border-black bg-black text-white shadow-md' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}
                        >
                            <span className="text-xs font-black uppercase tracking-tight">{p.name}</span>
                            <span className={`text-[10px] font-medium leading-snug break-keep ${selectedPhotographer === p.id ? 'text-gray-300' : 'text-gray-500'}`}>{p.desc}</span>
                        </button>
                    ))}
                </div>
            </div>

            <button onClick={handleGenerate} disabled={isGenerating || !targetImage || !prompt} className={`w-full text-white py-4 font-bold text-base uppercase mt-2 hover:opacity-90 disabled:opacity-50 flex flex-col items-center justify-center gap-1 ${generatedImages.length > 0 ? 'bg-gray-800' : 'bg-black'}`}>
                {isGenerating ? (
                    <><Loader2 className="w-5 h-5 animate-spin" /> <span>{generatedImages.length > 0 ? '다시 생성 중 (4장)...' : '생성 중 (4장)...'}</span></>
                ) : (
                    generatedImages.length > 0 ? (
                        <><div className="flex items-center gap-2"><RefreshCcw className="w-5 h-5 text-white" /> 다시 4장 생성하기 (REGENERATE)</div></>
                    ) : (
                        <><div className="flex items-center gap-2"><Sparkles className="w-5 h-5 text-white" /> 화보 4장 자동생성 (GENERATE)</div></>
                    )
                )}
            </button>
          </div>

        </div>
      </div>
      <ImageViewerModal isOpen={showZoomModal} onClose={() => setShowZoomModal(false)} imageSrc={generatedImages[currentImgIndex]} />

      {showSwapModal && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={() => setShowSwapModal(false)}>
          <div className="bg-white w-full max-w-5xl max-h-[85vh] flex flex-col border-2 border-black shadow-2xl animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="h-14 px-6 border-b border-black flex items-center justify-between shrink-0">
              <h2 className="text-lg font-black uppercase tracking-tighter flex items-center gap-2"><RefreshCcw className="w-4 h-4" /> 스타일 베이스 교체</h2>
              <button onClick={() => setShowSwapModal(false)} className="p-1 hover:bg-gray-100 rounded-full"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-6 py-3 border-b border-black flex items-center gap-4 flex-wrap shrink-0">
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => setSwapBrandFilter('All')} className={`px-3 py-1.5 text-xs font-bold uppercase border ${swapBrandFilter === 'All' ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300'}`}>ALL</button>
                {FIXED_BRANDS.map(b => (
                  <button key={b} onClick={() => setSwapBrandFilter(b)} className={`px-3 py-1.5 text-xs font-bold uppercase border ${swapBrandFilter === b ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300'}`}>{b}</button>
                ))}
              </div>
              <label className="ml-auto text-xs font-bold uppercase bg-white text-black px-3 py-1.5 border border-black hover:bg-black hover:text-white cursor-pointer flex items-center gap-1 transition-colors">
                <UploadCloud className="w-3 h-3" /> 새 이미지 업로드
                <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const r = new FileReader();
                  r.onload = async () => {
                    try {
                      const img = await compressImage(r.result, 1024, 0.8);
                      setCurrentReference({ id: `tmp-${Date.now()}`, name: file.name.replace(/\.[^/.]+$/, '').toUpperCase(), image: img, brand: currentReference?.brand || 'EZ' });
                      setShowSwapModal(false);
                      showNotification("새 레퍼런스 이미지로 교체되었습니다. (임시 — 저장되지 않음)");
                    } catch { /* ignore */ }
                  };
                  r.readAsDataURL(file);
                  e.target.value = '';
                }} />
              </label>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
              <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
                {references.filter(r => swapBrandFilter === 'All' || r.brand === swapBrandFilter).map(r => (
                  <div key={r.id} onClick={() => { setCurrentReference(r); setShowSwapModal(false); showNotification("스타일 베이스가 교체되었습니다."); }} className={`aspect-[3/4] border cursor-pointer relative group overflow-hidden ${currentReference?.id === r.id ? 'border-black ring-2 ring-black' : 'border-gray-300 hover:border-black'}`}>
                    <img src={r.image} className="w-full h-full object-cover group-hover:scale-105 transition-transform" alt={r.name} loading="lazy" />
                    <div className="absolute bottom-0 left-0 right-0 bg-black/80 text-white text-[9px] font-bold text-center py-0.5">{r.brand}</div>
                    {currentReference?.id === r.id && (
                      <div className="absolute top-1 right-1 bg-black text-white text-[9px] font-bold px-1.5 py-0.5 uppercase">현재</div>
                    )}
                  </div>
                ))}
                {references.filter(r => swapBrandFilter === 'All' || r.brand === swapBrandFilter).length === 0 && (
                  <div className="col-span-full text-center py-10 text-gray-400 font-bold text-sm uppercase">해당 브랜드에 등록된 레퍼런스가 없습니다.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const FittingRoomGenerator = ({ settings, showNotification }) => {
  const [faceImage, setFaceImage] = useState(null);
  const [bodyImage, setBodyImage] = useState(null);
  const [items, setItems] = useState([
    { id: 1, type: 'OUTER', image: null, label: '아우터 (Outer)' },
    { id: 2, type: 'TOP', image: null, label: '상의 (Top)' },
    { id: 3, type: 'BOTTOM', image: null, label: '하의 (Bottom)' },
    { id: 4, type: 'SHOES', image: null, label: '신발 (Shoes)' }
  ]);
  const [mainItemId, setMainItemId] = useState(1);
  const [mainItemDetails, setMainItemDetails] = useState([]);
  const [fittingPrompt, setFittingPrompt] = useState('');
  const [bgTone, setBgTone] = useState('bright');
  const [customBgImage, setCustomBgImage] = useState(null);
  const [generatedFits, setGeneratedFits] = useState([]);
  const [currentFitIndex, setCurrentFitIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showZoomModal, setShowZoomModal] = useState(false);

  const fittingSnippets = [
      "Full Body이미지와 배경색,조명 동일하게",
      "바지는 매우 길고 와이드해서 신발 위에 주름이 약간 잡혀있다.",
      "매우 루즈한 오버핏 연출",
      "드롭숄더",
      "극도의 오버핏",
      "벌룬 배럴핏",
      "한 손은 바지 주머니에 자연스럽게 넣고, 다른 손은 옆에 편하게 내려둔 자세 (어깨 힘 빼고 자연스러운 무게중심)"
  ];

  const handleImageUpload = async (file, type, id = null) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
      try {
        const img = await compressImage(r.result, 1024, 0.8);
        if (type === 'face') setFaceImage(img);
        else if (type === 'body') setBodyImage(img);
        else if (type === 'item' && id) {
          setItems(prev => prev.map(item => item.id === id ? { ...item, image: img } : item));
        }
        else if (type === 'customBg') setCustomBgImage(img);
      } catch { /* ignore */ }
    };
    r.readAsDataURL(file);
  };

  const addItemSlot = () => {
    if (items.length >= 8) return showNotification("최대 4개의 추가 아이템만 등록 가능합니다.", "error");
    setItems(prev => [...prev, { id: Date.now(), type: 'ACC', image: null, label: '추가 아이템 (Acc)' }]);
  };

  const removeItemSlot = (id) => {
    if (id <= 4) {
      setItems(prev => prev.map(item => item.id === id ? { ...item, image: null } : item));
    } else {
      setItems(prev => prev.filter(item => item.id !== id));
    }
  };

  const handleDetailUpload = async (files) => {
    if (!files || files.length === 0) return;
    const newFiles = Array.from(files);
    const availableSlots = 3 - mainItemDetails.length;
    const filesToProcess = newFiles.slice(0, availableSlots);

    for (const file of filesToProcess) {
      const r = new FileReader();
      r.onload = async () => {
        try {
          const img = await compressImage(r.result, 1024, 0.8);
          setMainItemDetails(prev => [...prev, img]);
        } catch { /* ignore */ }
      };
      r.readAsDataURL(file);
    }
  };

  const handleDownload = () => {
    if (generatedFits.length === 0) return;
    const link = document.createElement('a');
    link.href = generatedFits[currentFitIndex];
    link.download = `Fitting_Result_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleGenerateFit = async () => {
    if (!faceImage || !bodyImage) return showNotification("모델의 얼굴과 전신 사진은 필수입니다.", "error");
    const activeItems = items.filter(i => i.image);
    if (activeItems.length === 0) return showNotification("적어도 하나 이상의 아이템을 등록해주세요.", "error");
    if (bgTone === 'custom' && !customBgImage) return showNotification("커스텀 배경 이미지를 업로드해주세요.", "error");

    setIsGenerating(true);
    setGeneratedFits([]);
    setCurrentFitIndex(0);

    try {
      const compFace = await compressImage(faceImage, 1024, 0.8);
      const compBody = await compressImage(bodyImage, 1024, 0.8);
      const compItems = await Promise.all(activeItems.map(async (item) => ({
        ...item,
        data: await compressImage(item.image, 1024, 0.8)
      })));
      const compDetails = await Promise.all(mainItemDetails.map(async (img) => await compressImage(img, 1024, 0.8)));
      const compCustomBg = bgTone === 'custom' && customBgImage ? await compressImage(customBgImage, 1024, 0.8) : null;

      let bgToneDesc = "";
      let customBgInstruction = "";
      if (bgTone === 'custom' && compCustomBg) {
          bgToneDesc = "Place the model in the EXACT environment and background shown in the LAST provided image [Background Image]. STRICTLY MAINTAIN the original color, tone, and details of this background image. Do not alter its hue or brightness.";
          customBgInstruction = "\n* [Background Image]: The LAST image provided is the target background. You MUST composite the model onto this exact background without changing the background's original colors.";
      } else if (bgTone === 'bright') {
          bgToneDesc = "Pure CLEAN white studio seamless backdrop (#FFFFFF), like a perfectly lit cyclorama. ABSOLUTELY NO atmospheric particles — no dust, no floating motes, no haze, no fog, no smoke. ABSOLUTELY NO light artifacts — no bokeh, no light orbs, no lens flare, no light leaks, no gradient glow, no color cast, no vignette. The background MUST be a perfectly uniform, completely flat white field with ZERO texture, ZERO grain, and ZERO ambient noise. High-key lighting, very bright and clean. STRICTLY MAINTAIN SOLID UNIFORM PURE WHITE.";
      } else if (bgTone === 'mid') {
          bgToneDesc = "Light neutral grey studio seamless backdrop. Balanced mid-tone background. STRICTLY MAINTAIN SOLID LIGHT GREY.";
      } else if (bgTone === 'dark') {
          bgToneDesc = "Medium grey studio seamless backdrop. Slightly moody and deep, but NOT pitch black. STRICTLY MAINTAIN SOLID MEDIUM GREY.";
      }

      let lightDesc = "Clean studio natural light with both main and bounce/fill lights evenly distributed. Soft, and clear illumination across the whole model. LIGHTING ANGLE AND INTENSITY ARE LOCKED.";

      let detailDesc = "";
      let detailInputText = "";
      if (compDetails.length > 0) {
          const mainItemLabel = items.find(i => i.id === mainItemId)?.label || "Main Item";
          detailDesc = `\nRULE 4: MAIN ITEM DETAILS LOCK (${mainItemLabel})\n- You MUST perfectly replicate the texture, material, stitching, and specific design patterns shown in the [Main Item Detail Images] for the ${mainItemLabel}. Do not hallucinate generic textures for this item.`;
          detailInputText = `\n* Following the wardrobe images, there are ${compDetails.length} [Main Item Detail Images]. Use these EXCLUSIVELY to extract the exact fabric texture, stitching, and micro-patterns for the MAIN ITEM.`;
      }

      const mainItem = items.find(i => i.id === mainItemId);
      const mainType = mainItem?.type || 'TOP';
      const mainLabel = mainItem?.label || 'Main Item';

      let focus3 = "", focus4 = "";
      if (mainType === 'BOTTOM') {
          focus3 = `Change the camera framing to a LOWER BODY MEDIUM SHOT (from waist line down to the ankles) facing the camera straight-on. The camera is at waist-to-thigh level. Focus explicitly on the pants/skirt silhouette, drape, and fit of the Main Item (${mainLabel}). The head/face does NOT need to be in frame. The lighting, shadows, and studio background MUST remain exactly the same.`;
          focus4 = `Change the camera framing to a LOWER BODY SHOT (from waist down to ankles) from a slight 3/4 side angle (about 25-30 degrees off-axis) to show the side silhouette, fabric drape, and fit of the Main Item (${mainLabel}). The camera is at waist level. Head/face does not need to be in frame. The lighting, shadows, and studio background MUST remain exactly the same.`;
      } else if (mainType === 'SHOES') {
          focus3 = `Change the camera framing to a FEET & LOWER LEG CLOSE-UP (from mid-shin down to the floor) at a straight frontal angle. The shoes (Main Item: ${mainLabel}) are the clear subject. The lighting, shadows, and studio background MUST remain exactly the same.`;
          focus4 = `Change the camera framing to a FEET CLOSE-UP from a slight 3/4 angle, with one foot slightly forward (or mid-stride) to show the shoe silhouette dynamically. The shoes (Main Item: ${mainLabel}) must remain the subject. The lighting, shadows, and studio background MUST remain exactly the same.`;
      } else {
          // OUTER, TOP, ACC, etc. → upper body focus
          focus3 = `Change the camera framing to an UPPER BODY MEDIUM SHOT (from the waist line up to the top of the head) facing the camera straight-on. The face IS in frame (keep the identity lock). Focus explicitly on the neckline, shoulders, chest, sleeves, and overall silhouette of the Main Item (${mainLabel}). The lighting, shadows, and studio background MUST remain exactly the same.`;
          focus4 = `Change the camera framing to an UPPER BODY MEDIUM SHOT (waist up to head) from a slight 3/4 side angle (about 25-30 degrees off-axis). The face is partially visible in profile (keep the identity lock). Focus on the side silhouette, sleeve drape, and how the Main Item (${mainLabel}) falls on the body. The lighting, shadows, and studio background MUST remain exactly the same.`;
      }

      const poseVariations = [
          "Change the model's pose: face completely straight forward at the camera in a CONFIDENT UPRIGHT STANCE — weight evenly on both feet, arms RELAXED at the sides, shoulders open, chin level, NEUTRAL CALM EXPRESSION (Pose A — Standard Front Pose). The full outfit silhouette must be clearly visible and unobstructed. The lighting, shadows, and studio background MUST remain exactly the same.",
          "Change the model's pose: still front-facing the camera but with a SUBSTANTIALLY DIFFERENT pose from Pose A — shift weight strongly to one leg (contrapposto), and place ONE HAND on the hip OR through the hair OR into a pants pocket (pick one naturally and effortlessly). The head and face ANGLE must be visibly different from Pose A (e.g. a slight head tilt, a small chin lift or drop, or a subtle head turn slightly off-axis). CRITICAL — KEEP THE SAME FACIAL EXPRESSION as Pose A: the expression itself does NOT change between Pose A and Pose B. Only the body posture, hand placement, and head/face ANGLE differ — the expression stays consistent. This must look like a distinctly different photo moment captured moments after Pose A from the same session, NOT a near-duplicate. The full outfit silhouette must remain clearly visible and unobstructed. The lighting, shadows, and studio background MUST remain exactly the same.",
          focus3,
          focus4
      ];

      const promises = poseVariations.map((poseDesc, i) => {
          return new Promise(async (resolve, reject) => {
              try {
                  await delay(i * 1500);

                  const baseParts = [
                    { text: `
                      TASK: High-Fidelity Virtual Try-On & Identity Compositing with **ABSOLUTE SUBJECT PRESERVATION**.

                      ROLE: You are an expert Image Compositor. You COMBINE the face from Image [1] with the body from Image [2] to create ONE UNIFIED MODEL, then dress that model in the wardrobe from Images [3+].
                      ${customBgInstruction}
                      ${detailInputText}

                      =========================================
                      #1 ABSOLUTE NON-NEGOTIABLE PRIORITY — IDENTITY PRESERVATION
                      =========================================
                      The single most important requirement, overriding everything else: the person in all 4 generated images MUST be the EXACT SAME PERSON shown in [Image 1] (face) and [Image 2] (body). NEVER generate a new person, a different person, a "similar-looking" person, an "averaged" person, or a "stylized" person. Any drift in identity is an immediate HARD FAILURE. If you cannot preserve the identity, refuse to generate rather than produce a substitute.

                      Identity markers that MUST be carried over verbatim (no exceptions):
                      - ETHNICITY / RACE: the model's exact ethnicity is FIXED to what is shown in Image [1] and Image [2]. NEVER change Asian to Caucasian, NEVER change Black to mixed, NEVER drift toward a "default" western/eastern face. Race/ethnicity is locked.
                      - SKIN TONE & UNDERTONE: copy the exact skin hue, value, and undertone (warm/cool/neutral) from the source images. NEVER lighten, NEVER darken, NEVER beautify the skin. Match the precise skin color including any tan lines, redness, blemishes, or pigmentation visible in the source.
                      - AGE: preserve the apparent age exactly. NEVER make the model younger or older.
                      - GENDER PRESENTATION: preserve exactly as shown.
                      - FACIAL FEATURES: eye shape and spacing, eyelid fold (monolid / double / hooded), iris color, eyebrow shape and density, nose bridge / nostril / nose tip, lip shape and fullness, philtrum, mouth corner angle, jawline angle, chin shape, cheekbone height, ear shape — all copied verbatim.
                      - SKIN MARKERS: every freckle, mole, birthmark, scar, dimple, beauty mark MUST be preserved at its exact position. These are identity-defining.
                      - HAIR: exact hair color, texture (straight/wavy/curly/coily), density, hairline, parting, hairstyle volume, length — all preserved.
                      - BODY: height ratio, shoulder width, limb length, body type (slim/athletic/curvy/etc.), hand size, foot size, posture — all from Image [2].
                      - VISIBLE SKIN ANYWHERE: arms, hands, neck, chest, legs (whatever is exposed by the outfit) MUST share the same skin tone as the face. NEVER let visible skin drift to a different color than the face.

                      PROHIBITIONS (each is a hard failure):
                      - Generating a "similar but different" person
                      - "Averaging" facial features toward a generic look
                      - "Beautifying" or removing skin markings/imperfections
                      - Shifting ethnicity even slightly (e.g. making the eyes look more Western, or the nose look more European, etc.)
                      - Lightening or smoothing the skin tone
                      - Generating different people across the 4 variations (all 4 MUST be the SAME person)

                      =========================================

                      RULE 1: FACIAL IDENTITY LOCK (100% Match Required - 최우선 순위: 이목구비 완벽 보존)
                      - SOURCE OF TRUTH: Image [1] — face. This is the SINGLE source of truth for facial identity.
                      - The generated model's face MUST be 100% identical to Image [1] in every micro-proportion, marker, and structural feature listed in the IDENTITY PRESERVATION block above.
                      - Result MUST be the EXACT SAME PERSON across all 4 variations.
                      - **CRITICAL: EVEN IF THE BODY POSE, CAMERA ANGLE, OR DIRECTION CHANGES, THE FACIAL IDENTITY (and especially ethnicity + skin tone) MUST REMAIN 100% LOCKED AND IDENTICAL TO IMAGE [1] whenever the face is visible at any size in the frame.**
                      - NO INTERPOLATION: do not "average", "smooth", "beautify", or "stylize" the face. Preserve micro-asymmetries, blemishes, and natural imperfections verbatim — they are part of the identity.

                      RULE 1-B: BODY & SKIN-TONE LOCK (extends RULE 1 to all visible skin)
                      - SOURCE OF TRUTH: Image [2] — body.
                      - The body's height, build, posture, and skin tone (on every visible patch — arms, hands, neck, decolletage, legs, ankles, feet) MUST match Image [2] exactly.
                      - The face skin tone (Image 1) and the body skin tone (Image 2) MUST be reconciled to the SAME unified skin color across the entire model — never let the face be one tone and the exposed arms/legs another.

                      RULE 1-C: WARDROBE ITEM LOCK (입력된 의상 그대로 보존 — HIGHEST PRIORITY)
                      - SOURCE OF TRUTH: each wardrobe input image (Images [3+]) is the SINGLE source of truth for that garment. The final image MUST render each garment exactly as shown in its source.
                      - PRESERVE VERBATIM for every garment:
                        * EXACT silhouette and cut (sleeve length, hem length, neckline shape, lapel/collar shape, pant rise/leg width/inseam, skirt length)
                        * EXACT color and color distribution (no recoloring, no saturation shift, no hue drift)
                        * EXACT print, pattern, graphic, embroidery, patch (copy raster-exact, do NOT redraw or simplify)
                        * EXACT fabric texture and weave (knit/woven/leather/denim/etc. — match the source)
                        * EXACT trims and hardware (buttons, zippers, snaps, rivets, eyelets, drawstrings, belts) — same count, same placement, same material
                        * EXACT logos, labels, brand text — pixel-faithful
                        * EXACT proportions of the garment relative to the body
                      - ANTI-RESTYLE: do NOT "redesign", "reinterpret", "modernize", "simplify", "ornament", or "improve" any garment. The input wardrobe is final.
                      - DRAPE-ONLY VARIATION: across the 4 variations, the garments themselves are 100% identical. The ONLY thing that changes per variation is HOW THE FABRIC NATURALLY DRAPES on the body due to the new pose (e.g. a hanging sleeve folds slightly differently when an arm moves) — but the garment itself, its color, length, cut, prints, trims are pixel-locked.
                      - PROHIBITION: NEVER substitute a garment for a "similar" one, NEVER change a top's neckline, NEVER alter pant length/leg width, NEVER add or remove buttons/pockets/details, NEVER recolor, NEVER swap fabric type. Any drift from the source garment is a HARD FAILURE.

                      RULE 2: POSE, FRAMING & PROPORTION (ISOLATED CHANGE)
                      - ${poseDesc}
                      - ABSOLUTE PROPORTION LOCK: The model's physical dimensions (overall height, shoulder width, limb length, body ratio) MUST perfectly match [Image 2]. Never distort, stretch, or shrink the body.
                      - CRITICAL ISOLATION: When applying the new pose, ONLY the body posture / arm-and-leg placement / head angle / facial expression should change. THE WARDROBE ITEMS THEMSELVES (their color, cut, length, prints, trims, and silhouette) STAY 100% LOCKED to the source images per RULE 1-C — only how the existing fabric naturally drapes/folds on the new pose may shift.
                      - The background, lighting direction, shadow intensity, and studio environment ALSO remain 100% locked and identical (per RULE 3).

                      RULE 3: STUDIO BACKGROUND & LIGHTING (ABSOLUTE ENVIRONMENTAL LOCK)
                      - ${bgToneDesc}
                      - ${lightDesc}
                      - 4-IMAGE HARD CONSISTENCY LOCK: This is one of 4 fitting images generated from the SAME continuous studio session. Treat all 4 as captured back-to-back from a single fixed light setup — only the photographer's camera position and the model's pose change, NOTHING else.
                        The following MUST be MATHEMATICALLY IDENTICAL across all 4 outputs:
                        * Background color, brightness, texture, and tone — pixel-locked
                        * Key light direction, intensity, color temperature (Kelvin), softness
                        * Fill light, rim light, bounce light positions and intensities — fixed
                        * Shadow direction, softness, and density (shadows shift only because the body moved, never because the lights moved)
                        * White balance, exposure, contrast, saturation, color grade
                        * Camera lens character, depth of field, sensor look
                        * The model's outfit (every garment from Images [3+] per RULE 1-C), hair, makeup, accessories — IDENTICAL in all 4 images. Garment color, cut, length, prints, trims, and fabric do NOT change between variations; only natural fabric drape responds to the new pose.
                      - CAMERA POSITION — MUST BE VISIBLY DIFFERENT IN EACH OF THE 4 IMAGES: the photographer's physical position (distance, height, horizontal/vertical angle relative to the model and the locked studio environment) must clearly differ across all 4 variations. Never duplicate the same camera placement on another variation. The lights/backdrop are locked; the photographer moves.
                      - POSE & EXPRESSION — SUBSTANTIALLY DIFFERENT IN EACH OF THE 4 IMAGES (NOT subtle micro-variations): each variation must show a distinctly different body posture, weight distribution, arm/hand placement, head tilt, gaze direction, AND facial expression. Two variations sharing essentially the same pose or expression is a hard failure.
                        OUTFIT-VISIBILITY CONSTRAINT: every pose MUST still showcase the outfit cleanly — keep the garment's silhouette, key details, and hemline readable. Do NOT cover the garment with crossed arms, do NOT obscure the chest/torso, do NOT crop key details with body language.
                      - PROHIBITED: do NOT introduce new props, do NOT shift the backdrop hue, do NOT change the lighting angle, do NOT add or remove atmospheric effects (haze/dust/glow) between variations. ANY drift in environment, lighting, color, or wardrobe between the 4 outputs is a HARD FAILURE.
                      ${detailDesc}

                      DIRECTOR'S NOTES:
                      "${fittingPrompt}"

                      ${HIGH_END_STYLE_PROMPT}
                    ` },
                    { inlineData: { mimeType: "image/jpeg", data: compFace.split(',')[1] } },
                    { inlineData: { mimeType: "image/jpeg", data: compBody.split(',')[1] } }
                  ];

                  let parts = baseParts.concat(compItems.map(item => ({ inlineData: { mimeType: "image/jpeg", data: item.data.split(',')[1] } })));
                  parts = parts.concat(compDetails.map(img => ({ inlineData: { mimeType: "image/jpeg", data: img.split(',')[1] } })));

                  if (bgTone === 'custom' && compCustomBg) {
                      parts.push({ inlineData: { mimeType: "image/jpeg", data: compCustomBg.split(',')[1] } });
                  }

                  const { dataUrl } = await geminiGenerateImage({
                    primaryModelId: settings.modelId || MODEL_OPTIONS.PRO,
                    fallbackModelId: null,
                    apiKey: settings.apiKey || DEFAULT_API_KEY,
                    contentsParts: parts,
                    aspectRatio: '3:4',
                    qualityMode: settings.highRes ? 'ultra' : 'std'
                  });
                  resolve(dataUrl);
              } catch(e) { reject(e); }
          });
      });

      const results = await Promise.allSettled(promises);
      const successfulImages = results.filter(r => r.status === 'fulfilled').map(r => r.value);

      if (successfulImages.length === 0) {
          const error = results.find(r => r.status === 'rejected')?.reason;
          throw error || new Error("피팅컷 생성 실패");
      }

      setGeneratedFits(successfulImages);
      if (successfulImages.length < 4) {
          showNotification(`4장 중 ${successfulImages.length}장만 생성되었습니다.`);
      } else {
          showNotification("4장의 피팅컷이 성공적으로 생성되었습니다.");
      }

    } catch (e) {
      showNotification("코디 생성 실패: " + String(e.message || e), "error");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-row h-full bg-white">
      <div className="flex-1 flex flex-col p-8 overflow-y-auto bg-gray-50 border-r border-black">
        <div className="max-w-4xl mx-auto w-full flex flex-col gap-8">

          <div>
            <h3 className="text-xl font-black uppercase mb-2 flex items-center gap-2"><UserCheck className="w-6 h-6" /> Model Source</h3>
            <p className="text-sm text-gray-600 mb-4 font-medium">동일한 모델의 2장 사진을 업로드하세요. AI가 얼굴과 전신을 하나의 모델로 합성합니다.</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <span className="text-sm font-bold uppercase mb-2 bg-black text-white px-2 py-1 w-fit">1. Face Closeup </span>
                <div onClick={() => document.getElementById('face-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'face'); }} className="aspect-[3/4] border-2 border-dashed border-gray-400 bg-white hover:border-black cursor-pointer flex items-center justify-center relative transition-colors overflow-hidden">
                  {faceImage ? <img src={faceImage} className="w-full h-full object-cover" alt="Face" /> : <div className="text-center"><ImageIcon className="w-8 h-8 mx-auto text-gray-300 mb-2"/><span className="text-sm font-bold text-gray-400">얼굴 클로즈업</span><span className="text-xs text-gray-400 mt-1 block">눈/코/입 선명하게</span></div>}
                  <input id="face-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'face')} />
                </div>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-bold uppercase mb-2 bg-gray-200 text-black px-2 py-1 w-fit">2. Full Body</span>
                <div onClick={() => document.getElementById('body-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'body'); }} className="aspect-[3/4] border-2 border-dashed border-gray-400 bg-white hover:border-black cursor-pointer flex items-center justify-center relative transition-colors overflow-hidden">
                  {bodyImage ? <img src={bodyImage} className="w-full h-full object-contain" alt="Body" /> : <div className="text-center"><UserCheck className="w-8 h-8 mx-auto text-gray-300 mb-2"/><span className="text-sm font-bold text-gray-400">전신 사진</span><span className="text-xs text-gray-400 mt-1 block">머리부터 발끝까지</span></div>}
                  <input id="body-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'body')} />
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-xl font-black uppercase flex items-center gap-2"><Scissors className="w-6 h-6" /> Wardrobe Items</h3>
              <button onClick={addItemSlot} className="text-sm font-bold uppercase flex items-center gap-1 bg-black text-white px-3 py-1.5 hover:opacity-80 disabled:opacity-50" disabled={items.length >= 8}><PlusCircle className="w-4 h-4"/> Add Item</button>
            </div>
            <p className="text-sm text-gray-600 mb-4 font-medium">모델에게 입힐 의상 아이템을 등록하세요. </p>
            <div className="grid grid-cols-4 gap-4 mb-8">
              {items.map((item, idx) => (
                <div key={item.id} className="flex flex-col">
                  <div className="flex justify-between items-center mb-1">
                    <div className="flex items-center gap-1">
                       <button onClick={() => setMainItemId(item.id)} className={`text-[9px] font-bold px-1.5 py-0.5 border ${mainItemId === item.id ? 'bg-black text-white border-black' : 'bg-white text-gray-400 border-gray-300 hover:border-black transition-colors'}`}>
                          MAIN
                       </button>
                       <span className="text-xs font-bold uppercase text-gray-500">{item.label}</span>
                    </div>
                    {(idx > 3 || item.image) && <button onClick={() => removeItemSlot(item.id)} className="text-black hover:bg-gray-200 rounded-full p-1"><MinusCircle className="w-4 h-4"/></button>}
                  </div>
                  <div onClick={() => document.getElementById(`item-upload-${item.id}`).click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'item', item.id); }} className={`aspect-[3/4] border ${mainItemId === item.id ? 'border-2 border-black' : 'border border-gray-300 hover:border-black'} bg-white cursor-pointer flex items-center justify-center relative transition-colors overflow-hidden`}>
                    {item.image ? <img src={item.image} className="w-full h-full object-contain p-2" alt={item.label} /> : <div className="text-center"><Shirt className="w-6 h-6 mx-auto text-gray-200 mb-1"/><span className="text-[10px] font-bold text-gray-300">선택</span></div>}
                    <input id={`item-upload-${item.id}`} type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'item', item.id)} />
                  </div>
                </div>
              ))}
            </div>

            {/* 3. Styling Notes (먼저) */}
            <div className="mb-8">
               <h3 className="text-xl font-black uppercase flex items-center gap-2 mb-2"><Highlighter className="w-6 h-6" /> Styling Director Notes</h3>

               <div className="mb-4 bg-gray-50 border border-gray-200 p-4">
                  <span className="text-[11px] font-bold text-black uppercase flex items-center gap-1 mb-3">
                     <Tag className="w-3 h-3"/> 메인 상품 디테일 컷 (최대 3장)
                  </span>
                  <div className="flex gap-2 items-start">
                     {mainItemDetails.map((img, idx) => (
                        <div key={idx} className="relative w-16 h-16 border border-gray-300 shrink-0 bg-white">
                           <img src={img} className="w-full h-full object-cover" alt={`Detail ${idx+1}`} />
                           <button onClick={() => setMainItemDetails(prev => prev.filter((_, i) => i !== idx))} className="absolute -top-1.5 -right-1.5 bg-black rounded-full text-white p-0.5 hover:bg-gray-800"><X className="w-3 h-3"/></button>
                        </div>
                     ))}
                     {mainItemDetails.length < 3 && (
                        <div onClick={() => document.getElementById('main-detail-upload').click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleDetailUpload(e.dataTransfer.files); }} className="w-16 h-16 border-2 border-dashed border-gray-300 bg-white cursor-pointer flex flex-col items-center justify-center shrink-0 hover:border-black transition-colors">
                           <Plus className="w-4 h-4 text-gray-400 mb-0.5"/>
                           <span className="text-[8px] font-bold text-gray-500 text-center leading-tight">디테일<br/>추가</span>
                           <input id="main-detail-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleDetailUpload(e.target.files)} />
                        </div>
                     )}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-2 font-medium">메인으로 설정된 의상의 디테일(원단 질감, 패턴, 재봉선 등)을 명확히 반영하기 위한 참고 이미지입니다.</p>
               </div>

               <div className="flex flex-wrap gap-2 mb-2">
                 {fittingSnippets.map(s => (
                    <button key={s} onClick={() => appendPromptSnippet(s, setFittingPrompt)} className="text-[11px] font-bold px-2 py-1 bg-gray-100 border border-gray-200 hover:bg-gray-200 text-gray-700 transition-colors">
                      + {s}
                    </button>
                 ))}
               </div>
               <div className="flex gap-4 items-stretch">
                   <textarea
                      value={fittingPrompt || ''}
                      onChange={(e) => setFittingPrompt(e.target.value)}
                      className="flex-1 h-32 p-4 border border-black text-sm focus:outline-none bg-gray-50 font-medium leading-relaxed overflow-y-auto resize-none"
                      placeholder="예: 모자는 푹 눌러쓰고, 신발은 스포티하게 연출해주세요..."
                    />
                    <button onClick={handleGenerateFit} disabled={isGenerating || !faceImage || !bodyImage} className={`w-36 text-white font-bold text-base uppercase transition-all flex flex-col items-center justify-center gap-1 ${generatedFits.length > 0 ? 'bg-gray-800 hover:bg-gray-900' : 'bg-black hover:bg-gray-800'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                        {isGenerating ? (
                          <><Loader2 className="w-6 h-6 animate-spin" /> <span>피팅 4장<br/>생성 중...</span></>
                        ) : (
                          generatedFits.length > 0 ? (
                            <><RefreshCcw className="w-6 h-6 text-white" /> <span className="text-center">코디 4장<br/>재생성</span></>
                          ) : (
                            <><Sparkles className="w-6 h-6 text-white" /> <span className="text-center">피팅 4장<br/>자동생성</span></>
                          )
                        )}
                     </button>
               </div>
             </div>

            {/* 4. Studio Background Tone (이제 가장 아래로 이동) */}
            <div>
               <h3 className="text-xl font-black uppercase flex items-center gap-2 mb-2"><Sun className="w-6 h-6" /> Background Tone</h3>
               <p className="text-sm text-gray-500 font-bold mb-3">기본적인 메인광+반사광 스튜디오 세팅에서 배경의 밝기 톤을 선택하세요.</p>
               <div className="grid grid-cols-4 gap-2">
                   <button onClick={() => setBgTone('bright')} className={`p-3 text-[12px] font-bold transition-all border-2 ${bgTone === 'bright' ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                       밝게 (Pure White)
                   </button>
                   <button onClick={() => setBgTone('mid')} className={`p-3 text-[12px] font-bold transition-all border-2 ${bgTone === 'mid' ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                       중간 (Light Grey)
                   </button>
                   <button onClick={() => setBgTone('dark')} className={`p-3 text-[12px] font-bold transition-all border-2 ${bgTone === 'dark' ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                       어둡게 (Medium Grey)
                   </button>
                   <button onClick={() => setBgTone('custom')} className={`p-3 text-[12px] font-bold transition-all border-2 ${bgTone === 'custom' ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                       커스텀 배경지
                   </button>
               </div>
               {bgTone === 'custom' && (
                  <div className="mt-2 p-3 bg-white border border-black rounded-sm">
                      <p className="text-[11px] font-bold text-black mb-2 uppercase">합성할 커스텀 배경 이미지를 업로드하세요 (원본 색상/톤 완전 유지)</p>
                      <div onClick={() => document.getElementById('fitting-custom-bg-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'customBg'); }} className="h-24 border border-dashed border-gray-300 hover:border-black bg-gray-50 cursor-pointer flex items-center justify-center relative">
                          {customBgImage ? <img src={customBgImage} className="w-full h-full object-cover opacity-80" alt="Custom BG" /> : <div className="text-center"><ImageIcon className="w-5 h-5 text-gray-400 mx-auto mb-1"/><span className="text-[10px] text-gray-500 font-bold">클릭하여 배경 추가</span></div>}
                          <input id="fitting-custom-bg-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'customBg')} />
                      </div>
                  </div>
               )}
            </div>
          </div>

        </div>
      </div>

      <div className="w-1/2 bg-white border-l border-black flex flex-col z-20 shadow-xl shrink-0">
        <div className="h-16 px-6 border-b border-black flex items-center justify-between bg-black text-white shrink-0">
          <h2 className="text-xl font-black uppercase tracking-tighter flex items-center gap-2"><Layers className="w-5 h-5"/> Fitting Room Result</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6 custom-scrollbar">

          {generatedFits.length > 0 ? (
            <div className="flex flex-col gap-4 animate-fade-in border-b-2 border-black pb-8">
              <div className="flex items-center gap-2 mb-1">
                 <CheckCircle2 className="w-5 h-5 text-black" />
                 <span className="text-sm font-bold uppercase text-black">Generation Complete ({currentFitIndex + 1}/{generatedFits.length})</span>
                 <span className="text-[10px] font-bold bg-gray-200 px-2 py-1 ml-auto">
                    {(() => {
                      const t = items.find(i => i.id === mainItemId)?.type;
                      const isLower = t === 'BOTTOM' || t === 'SHOES';
                      if (currentFitIndex === 0) return '정면 1';
                      if (currentFitIndex === 1) return '정면 2';
                      if (currentFitIndex === 2) return isLower ? '하반신 정면' : '상반신 정면';
                      return isLower ? '하반신 사이드' : '상반신 사이드';
                    })()}
                 </span>
              </div>
              <div className="aspect-[3/4] border border-black bg-gray-100 relative group">
                <img src={generatedFits[currentFitIndex]} className="w-full h-full object-cover cursor-pointer" onClick={() => setShowZoomModal(true)} alt="Generated Fit" />
                <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity pointer-events-none"><Maximize2 className="w-8 h-8 text-white drop-shadow-md" /></div>
                <button onClick={(e) => { e.stopPropagation(); handleDownload(); }} title="다운로드" className="absolute top-3 right-3 z-20 bg-white/95 hover:bg-white border border-black p-2 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"><Download className="w-4 h-4 text-black" /></button>

                {generatedFits.length > 1 && (
                  <>
                    <button onClick={(e) => { e.stopPropagation(); setCurrentFitIndex(p => Math.max(0, p - 1)); }} disabled={currentFitIndex === 0} className="absolute left-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 hover:bg-white text-black rounded-full disabled:opacity-30 z-10 shadow-md">
                      <ChevronLeft className="w-6 h-6" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setCurrentFitIndex(p => Math.min(generatedFits.length - 1, p + 1)); }} disabled={currentFitIndex === generatedFits.length - 1} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-white/80 hover:bg-white text-black rounded-full disabled:opacity-30 z-10 shadow-md">
                      <ChevronRight className="w-6 h-6" />
                    </button>
                    <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-2 z-10">
                       {generatedFits.map((_, i) => (
                          <div key={i} className={`w-2 h-2 rounded-full ${i === currentFitIndex ? 'bg-black shadow-[0_0_2px_white]' : 'bg-gray-400 shadow-[0_0_2px_black]'}`} />
                       ))}
                    </div>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={handleDownload} className="w-full bg-black text-white py-4 font-bold uppercase hover:opacity-80 flex items-center justify-center gap-2" title="현재 이미지 다운로드"><Download className="w-5 h-5" /> 다운로드 (로컬 저장)</button>
              </div>
            </div>
          ) : (
            <div className="aspect-[3/4] border-2 border-dashed border-gray-200 bg-gray-50 flex flex-col items-center justify-center text-gray-400">
              <Layers className="w-12 h-12 mb-2 opacity-20"/>
              <span className="text-sm font-bold uppercase opacity-50">Generated Fitting will appear here</span>
            </div>
          )}
        </div>
      </div>
      <ImageViewerModal isOpen={showZoomModal} onClose={() => setShowZoomModal(false)} imageSrc={generatedFits[currentFitIndex]} />
    </div>
  );
};

const ProductStudioGenerator = ({ settings, showNotification }) => {
  const [productImages, setProductImages] = useState([]); // 최대 6장
  const [productDetailImages, setProductDetailImages] = useState([]); // 디테일컷 최대 3장 (라벨·원단 클로즈업)
  const [customBgImage, setCustomBgImage] = useState(null);
  const [moodReferenceImage, setMoodReferenceImage] = useState(null);

  const [selectedBg, setSelectedBg] = useState('whiteboard');
  const [selectedLighting, setSelectedLighting] = useState('softbox');

  const [prompt, setPrompt] = useState('');
  const [generatedImage, setGeneratedImage] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showZoomModal, setShowZoomModal] = useState(false);

  const productSnippets = ["다림질한 듯 빳빳하게", "자연스러운 주름 유지", "그림자를 길게 연출", "고급스러운 반사광 추가", "선명한 텍스처 강조"];

  const bgOptions = [
    { id: 'whiteboard', label: '화이트보드', desc: '깔끔한 흰색 무배경' },
    { id: 'blackboard', label: '블랙보드', desc: '어둡고 깔끔한 질감' },
    { id: 'concrete', label: '심플 콘크리트', desc: '미니멀한 질감의 콘크리트 바닥' },
    { id: 'linen', label: '네츄럴 린넨', desc: '부드럽고 따뜻한 린넨 천 질감' },
    { id: 'white_paint', label: '하얀 페인트', desc: '깨끗한 흰색 페인트 바닥' },
    { id: 'dark_grey_paint', label: '짙은 회색 페인트', desc: '무게감 있는 회색 페인트' },
    { id: 'custom', label: '첨부 이미지', desc: '원하는 배경을 직접 업로드' }
  ];

  const lightingOptions = [
    { id: 'softbox', label: '소프트박스 조명', desc: '부드럽고 고른 스튜디오 조명' },
    { id: 'flash', label: '플래쉬 조명', desc: '강한 대비와 선명한 그림자' },
    { id: 'strong_natural', label: '강한 자연광', desc: '깊은 그림자가 지는 쨍한 햇빛' },
    { id: 'soft_natural', label: '네츄럴 자연광', desc: '창가로 들어오는 은은한 빛' }
  ];

  const handleImageUpload = async (file, type) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = async () => {
        try {
            const img = await compressImage(r.result, 1024, 0.8);
            if (type === 'customBg') setCustomBgImage(img);
            if (type === 'moodRef') setMoodReferenceImage(img);
        } catch { /* ignore */ }
    };
    r.readAsDataURL(file);
  };

  const handleProductUpload = async (files) => {
    if (!files || files.length === 0) return;
    const available = 6 - productImages.length;
    if (available <= 0) return showNotification("최대 6장까지 업로드 가능합니다.", "error");
    const toProcess = Array.from(files).slice(0, available);
    for (const file of toProcess) {
      const r = new FileReader();
      r.onload = async () => {
        try {
          const img = await compressImage(r.result, 1024, 0.8);
          setProductImages(prev => prev.length < 6 ? [...prev, img] : prev);
        } catch { /* ignore */ }
      };
      r.readAsDataURL(file);
    }
  };

  const removeProductAt = (idx) => {
    setProductImages(prev => prev.filter((_, i) => i !== idx));
  };

  const handleDetailCutUpload = async (files) => {
    if (!files || files.length === 0) return;
    const available = 3 - productDetailImages.length;
    if (available <= 0) return showNotification("디테일컷은 최대 3장까지 업로드 가능합니다.", "error");
    const toProcess = Array.from(files).slice(0, available);
    for (const file of toProcess) {
      const r = new FileReader();
      r.onload = async () => {
        try {
          const img = await compressImage(r.result, 1024, 0.8);
          setProductDetailImages(prev => prev.length < 3 ? [...prev, img] : prev);
        } catch { /* ignore */ }
      };
      r.readAsDataURL(file);
    }
  };

  const removeDetailAt = (idx) => {
    setProductDetailImages(prev => prev.filter((_, i) => i !== idx));
  };

  const analyzeMoodReferenceLayout = async (moodImageDataUrl) => {
    const apiKeyToUse = settings?.apiKey || DEFAULT_API_KEY;
    const compMood = await compressImage(moodImageDataUrl, 1024, 0.8);
    const analysisPrompt = `
당신은 제품 촬영 레퍼런스 이미지의 배치(레이아웃)를 분석하는 전문가입니다.

주어진 이미지에서 의류/제품이 어떻게 배치되어 있는지만 "정확하고 모호함 없이" 기술하세요.
다른 시스템이 이 분석만 보고 동일한 배치를 재현할 수 있어야 합니다.

다음 5가지 항목을 순서대로 출력하세요:

1. 진열 방식 (Display Mode):
   - 평면에 눕혀져 있음 (flat-lay / laid flat)
   - 행거·옷걸이·봉·후크에 걸려 있음 (hanging)
   - 벽에 핀/못으로 고정 (pinned to wall)
   - 가구·의자 위에 걸쳐짐 (draped)
   - 개어서 쌓여 있음 (folded stack)
   - 혼합이면 각각 어떤 아이템이 어느 방식인지 명확히 구분

2. 각 아이템별 위치 & 상태:
   아이템마다 번호를 매기고 (아이템 1, 아이템 2, …), 각각에 대해 기술:
   - 프레임 내 위치: 상/중/하 × 좌/중/우 (예: "상단-좌측", "중단-중앙")
   - 걸림/눕힘 여부 (걸림이면 무엇에 걸렸는지: 옷걸이 / 봉 / 후크)
   - 방향/자세: 앞면 보임 / 뒷면 보임 / 접힌 상태 / 부분 접힘 / 완전히 펼쳐짐 / 드레이핑
   - 회전/기울기: 정렬된 각도인지, 기울어져 있는지 (대략 몇 도)

3. 간격 & 겹침:
   - 아이템 간 간격이 넓은지/좁은지/맞닿는지/겹치는지
   - 겹친다면 어느 아이템이 위에, 어느 아이템이 아래에 있는지

4. 전체 구도:
   - 그리드 / 한 줄 가로 / 한 줄 세로 / 대각선 / 원형 / 클러스터 / 흩뿌림 / 계단식 등

5. 여백 (Negative Space):
   - 전체 프레임에서 아이템이 차지하는 비율
   - 여백이 많은 쪽 (상/하/좌/우)

출력 규칙:
- 반드시 한국어로
- 색상·브랜드·원단 종류·스타일은 절대 언급하지 말 것 (오직 위치·방향·구조만)
- 간결하게, 번호와 줄바꿈으로 구조화
- 서론·결론 없이 바로 본문만
`;

    const parts = [
      { text: analysisPrompt },
      { inlineData: { mimeType: "image/jpeg", data: compMood.split(',')[1] } }
    ];

    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${ANALYSIS_MODEL_ID}:generateContent?key=${apiKeyToUse}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] })
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(`Analysis API Error: ${data.error.message}`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("무드 레퍼런스 분석 결과가 비어있습니다.");
    return text.trim();
  };

  const handleDownloadImage = () => {
    if (!generatedImage) return;
    const link = document.createElement('a');
    link.href = generatedImage;
    link.download = `Product_Shot_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleGenerate = async () => {
    if (productImages.length === 0) return showNotification("제품 원본 이미지를 최소 1장 업로드해주세요.", "error");
    if (selectedBg === 'custom' && !customBgImage) return showNotification("커스텀 배경 이미지를 업로드해주세요.", "error");

    setIsGenerating(true);
    try {
      const compProducts = await Promise.all(productImages.map(img => compressImage(img, 1024, 0.8)));
      const compDetails = await Promise.all(productDetailImages.map(img => compressImage(img, 1024, 0.8)));
      const isGroup = compProducts.length > 1;
      const productCount = compProducts.length;
      const detailCount = compDetails.length;

      // STEP 1: Pre-analyze the mood reference layout (if provided) so the generation model
      // receives a structured textual blueprint rather than having to infer the layout itself.
      let moodAnalysis = null;
      if (moodReferenceImage) {
        try {
          showNotification("무드 레퍼런스 배치 분석 중...");
          moodAnalysis = await analyzeMoodReferenceLayout(moodReferenceImage);
        } catch (e) {
          console.warn("Mood reference analysis failed, continuing without structured analysis:", e);
        }
      }

      let bgDesc = "";
      if (selectedBg === 'whiteboard') bgDesc = "clean studio whiteboard background, pure white, infinite white seamless backdrop";
      else if (selectedBg === 'blackboard') bgDesc = "clean dark blackboard background, pure black, dark minimalist matte surface, sophisticated dark mood";
      else if (selectedBg === 'concrete') bgDesc = "simple raw concrete surface, minimalist industrial texture, neutral grey";
      else if (selectedBg === 'linen') bgDesc = "natural linen fabric background, soft textile texture, organic feel";
      else if (selectedBg === 'white_paint') bgDesc = "matte white painted floor surface, subtle paint texture, clean bright studio floor";
      else if (selectedBg === 'dark_grey_paint') bgDesc = "dark charcoal grey matte painted floor, deep grey painted surface, moody sophisticated studio background";
      else bgDesc = "Place the product naturally into the environment shown in the [Input Image 2]. The mood and setting should perfectly match the reference background.";

      let lightDesc = "";
      if (selectedLighting === 'softbox') lightDesc = "softbox diffused lighting, even illumination, soft shadows, studio lighting";
      else if (selectedLighting === 'flash') lightDesc = "direct hard flash lighting, high contrast, sharp edgy shadows, paparazzi style";
      else if (selectedLighting === 'strong_natural') lightDesc = "strong harsh natural sunlight, distinct deep shadows, golden hour";
      else lightDesc = "soft ambient natural window light, cloudy day, diffused natural illumination";

      let shapePreservationDesc = prompt
        ? `User's Additional Instructions (Apply these changes if requested): ${prompt}`
        : `CRITICAL FORM PRESERVATION: You MUST keep the EXACT physical silhouette, outline, folds, and wrinkles exactly as shown in the input image. DO NOT "tidy up", "iron out", or auto-correct the shape. If the original is wrinkled, messy, or asymmetrical, the output MUST be perfectly identical in its wrinkled/messy state.`;

      let moodRefDesc = "";
      let moodRefInputText = "";
      if (moodReferenceImage) {
          const analysisBlock = moodAnalysis
              ? `
            사전 분석 결과 (PRE-ANALYZED LAYOUT BLUEPRINT — follow this EXACTLY):
            <<<BEGIN LAYOUT ANALYSIS>>>
${moodAnalysis}
            <<<END LAYOUT ANALYSIS>>>
`
              : `
            (No structured analysis available — infer the arrangement from the last input image directly.)
`;

          moodRefDesc = `
            MOOD REFERENCE — LAYOUT BLUEPRINT (STRICT REPLICATION REQUIRED):
${analysisBlock}
            MANDATORY EXECUTION INSTRUCTIONS:
            - STEP 1 (UNDERSTAND): Parse the layout analysis above. Identify each "slot" — a slot is one item position in the reference, characterized by (display mode, frame position, orientation, rotation, scale).
            - STEP 2 (MAP): Assign the user's ${isGroup ? productCount + ' products' : 'product'} to the slots in order. User's [Input Image 1] → first slot described in the analysis, [Input Image 2] → second slot, and so on.
            - STEP 3 (RENDER): Render each user product at its assigned slot with the EXACT display mode, position, orientation, rotation, and relative scale described in the analysis.
              * If the analysis says "hanging from a hanger at top-center", the user's product must appear hanging from a hanger at top-center.
              * If the analysis says "laid flat, face-up, rotated ~15 degrees clockwise at bottom-left", the user's product must appear laid flat face-up rotated ~15° at bottom-left.
            - STEP 4 (COUNT MISMATCH): If the reference has MORE slots than user products (${productCount}), use only the first ${productCount} slots. If FEWER slots, extend the pattern (same display mode, same orientation logic, reasonable spacing) to accommodate all ${productCount} products.

            COLOR & TONE: Also apply the reference's color palette, film tone, and atmospheric mood as a subtle grading filter on the final image.

            ABSOLUTE PROHIBITION:
            - NEVER copy the literal products, logos, prints, patterns, or fabric types from the reference.
            - The ONLY products in the final image are the user-provided [Input Image 1${isGroup ? ` through ${productCount}` : ''}].
            - The reference image is a LAYOUT TEMPLATE + COLOR FILTER — not a content source.`;
          moodRefInputText = `\n            * The LAST input image is the [Mood Reference Image]. Its arrangement has been pre-analyzed and provided as a textual layout blueprint in the MOOD REFERENCE section below — follow that blueprint strictly.`;
      }

      const taskLine = isGroup
        ? `Group Product Photography (Flat-Lay GROUP composition of ${productCount} separate products in ONE single image).`
        : `Pure Product Photography (Flat-Lay Setup).`;

      const productRule = isGroup ? `
            RULE 1: GROUP PRODUCT IDENTITY & DETAIL LOCK (ABSOLUTE 100% Match Required - 각 제품의 라벨·로고·프린트·원단·재봉선·부자재까지 완벽 보존)
            - [Input Image 1] through [Input Image ${productCount}] each represent a SEPARATE individual product that MUST ALL appear together in ONE SINGLE group composition.
            - EXACTLY ${productCount} products must be visible in the final image — do NOT duplicate, merge, omit, or invent new products.
            - PIXEL-LEVEL DETAIL PRESERVATION for every product:
              * LABELS & TEXT: all brand labels, wash-care labels, hangtags, printed text, logos, typography MUST be copied exactly — identical font, spacing, color, position, and readability. DO NOT rewrite, translate, paraphrase, or distort any text.
              * FABRIC & MATERIAL: exact fabric weave, thread direction, knit pattern, leather grain, denim twill, stitching thread color, seam allowance, topstitching pitch, all trims (buttons, zippers, snaps, rivets, eyelets) MUST be preserved down to the micro-texture level.
              * PRINTS & GRAPHICS: all graphic prints, embroidery, patches, screen prints MUST match the source pixel-for-pixel.
              * COLOR: exact hue, saturation, and value of every product element — no AI color shift.
            - ANTI-HALLUCINATION: Do NOT smooth, re-illustrate, simplify, re-weave, or "beautify" any product detail. The output must feel like a high-resolution real photograph of the exact physical items.

            RULE 1-B: GROUP COMPOSITION
            - ${moodReferenceImage
                ? `The arrangement (positions, display mode, orientations, spacing) IS DICTATED by the MOOD REFERENCE LAYOUT BLUEPRINT. Follow that blueprint. Do not override it with a default flat-lay.`
                : `Arrange all ${productCount} products on the SAME single background surface in a visually balanced flat-lay. Natural aesthetic spacing; slight overlap allowed only if editorially meaningful.`}
            - Unified consistent lighting across all products — every product's shadow falls in a consistent natural direction.
            - FRAMING: zoom out so all ${productCount} products fit comfortably with ~10% margin on all sides. No item cropped at the edge.`
        : `
            RULE 1: PRODUCT IDENTITY & DETAIL LOCK (ABSOLUTE 100% Match Required - 라벨·로고·프린트·원단·재봉선·부자재까지 완벽 보존)
            - PIXEL-LEVEL DETAIL PRESERVATION for the product in [Input Image 1]:
              * LABELS & TEXT: all brand labels, wash-care labels, hangtags, printed text, logos, typography MUST be copied exactly — identical font, spacing, color, position, and readability. DO NOT rewrite, translate, paraphrase, or distort any text.
              * FABRIC & MATERIAL: exact fabric weave, thread direction, knit pattern, leather grain, denim twill, stitching thread color, seam allowance, topstitching pitch, all trims (buttons, zippers, snaps, rivets, eyelets) MUST be preserved down to the micro-texture level.
              * PRINTS & GRAPHICS: all graphic prints, embroidery, patches, screen prints MUST match the source pixel-for-pixel.
              * COLOR: exact hue, saturation, and value — no AI color shift.
            - ANTI-HALLUCINATION: Do NOT smooth, re-illustrate, simplify, re-weave, or "beautify" any product detail. The output must feel like a high-resolution real photograph of the exact physical item.
            - FRAMING & MARGINS: Zoom out the camera slightly to provide about 10% MORE negative space (margins) around the product than standard framing.`;

      const detailRule = detailCount > 0 ? `

            RULE 1-C: DETAIL CUT REFERENCES (LABEL & FABRIC LOCK — HIGHEST PRIORITY)
            - ${detailCount} detail close-up image${detailCount > 1 ? 's are' : ' is'} provided as [Input Image ${productCount + 1}${detailCount > 1 ? ` through ${productCount + detailCount}` : ''}] — immediately AFTER the ${productCount} product image${productCount > 1 ? 's' : ''}.
            - These detail cuts are AUTHORITATIVE sources of truth for the following features, OVERRIDING anything that might appear differently in the main product photo:
              * LABELS & TEXT — Reproduce every brand label, wash-care tag, hangtag, size tag, and printed text with PIXEL-LEVEL fidelity. Font face, kerning, line spacing, size, ink color, and exact character forms MUST match the detail cut exactly. DO NOT paraphrase, translate, simplify, or re-typeset any text. If a label says "100% COTTON MADE IN KOREA", the output must show exactly "100% COTTON MADE IN KOREA" in the same font.
              * FABRIC WEAVE & TEXTURE — The thread direction, weave pattern (warp/weft count), knit structure (rib/jersey/cable), leather grain, denim twill angle, linen slub, fleece pile, and all micro-textures shown in the detail image MUST be faithfully reproduced on the corresponding product surface in the final image.
              * STITCHING & TRIMS — Stitch type (lock/chain/overlock), stitch color, stitch pitch, topstitching pattern, zippers (metal/plastic, teeth size, pull shape), buttons (material, engraving, thread cross pattern), rivets, snaps, eyelets — all copied exactly from the detail cuts.
              * PRINTS, EMBROIDERY, PATCHES — Reproduce the raster pattern exactly; do not re-draw or simplify.
            - MATCHING: If ${detailCount > 1 ? 'multiple detail cuts are provided, match each one to the product it visually corresponds to (same color, same fabric family). ' : ''}Apply the detail reference to the appropriate region of the product in the final image.
            - STRICT PROHIBITION: The detail cut images MUST NOT appear as standalone objects in the final composition. They are ONLY references for micro-detail accuracy applied to the main product${isGroup ? 's' : ''}.`
        : '';

      const parts = [
        { text: `
            TASK: ${taskLine}

            CRITICAL RULE 1: NO HUMANS, NO PEOPLE, NO HANDS, NO BODY PARTS ALLOWED. ONLY THE PRODUCT${isGroup ? 'S' : ''}.
            CRITICAL RULE 2: SCENE SETUP - ${moodReferenceImage
                ? `The display mode (laid flat / hanging / draped / folded stacks / mixed) is DETERMINED BY the MOOD REFERENCE LAYOUT BLUEPRINT below. DO NOT default to flat-lay if the reference shows hanging or other arrangements. Follow the blueprint's display mode exactly.`
                : (isGroup ? `All ${productCount} products are lying completely FLAT on the same single background surface.` : 'The product is lying completely FLAT on the selected background surface.')}
            CRITICAL RULE 3: CAMERA - ${moodReferenceImage
                ? `Match the camera angle/framing implied by the MOOD REFERENCE LAYOUT BLUEPRINT (e.g. if hanging garments are shown frontally, use a front-facing camera; if flat-lay, use top-down).`
                : `Use a natural overhead top-down flat-lay perspective (shot directly from above, camera parallel to the surface).`}
            ${moodRefInputText}
${productRule}${detailRule}

            RULE 2: SHAPE & FOLD PRESERVATION
            ${shapePreservationDesc}

            ART DIRECTION:
            BACKGROUND: ${bgDesc}
            LIGHTING SETUP: ${lightDesc}
            ${moodRefDesc}

            ${HIGH_END_STYLE_PROMPT}
        ` },
        ...compProducts.map(img => ({ inlineData: { mimeType: "image/jpeg", data: img.split(',')[1] } })),
        ...compDetails.map(img => ({ inlineData: { mimeType: "image/jpeg", data: img.split(',')[1] } }))
      ];

      if (selectedBg === 'custom' && customBgImage) {
          const compCustomBg = await compressImage(customBgImage, 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compCustomBg.split(',')[1] } });
      }

      if (moodReferenceImage) {
          const compMoodRef = await compressImage(moodReferenceImage, 1024, 0.8);
          parts.push({ inlineData: { mimeType: "image/jpeg", data: compMoodRef.split(',')[1] } });
      }

      const { dataUrl } = await geminiGenerateImage({
        primaryModelId: settings.modelId || MODEL_OPTIONS.PRO,
        fallbackModelId: null,
        apiKey: settings.apiKey || DEFAULT_API_KEY,
        contentsParts: parts,
        aspectRatio: '1:1',
        qualityMode: settings.highRes ? 'ultra' : 'std'
      });
      setGeneratedImage(dataUrl);

      showNotification("제품컷이 성공적으로 생성되었습니다.");
    } catch(e) {
        showNotification(String(e.message || e), 'error');
    } finally {
        setIsGenerating(false);
    }
  };

  return (
    <div className="flex flex-row h-full bg-white relative">

      {/* Left Panel: Original Image & Controls (Scrollable) */}
      <div className="w-[600px] shrink-0 border-r border-black bg-gray-50 flex flex-col h-full z-10 shadow-xl overflow-hidden">
        <div className="h-16 px-5 border-b border-black bg-white flex items-center gap-2 sticky top-0 z-20 shrink-0">
          <Camera className="w-5 h-5"/>
          <h2 className="text-lg font-black uppercase tracking-tighter">Studio Controls</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-8 custom-scrollbar">

          {/* 0. Original Product Upload (최대 6장 → 2장 이상이면 단체컷) */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold uppercase flex items-center gap-2 text-black bg-gray-200 w-fit px-2 py-1"><Package className="w-4 h-4" /> 0. 원본 제품 이미지 ({productImages.length}/6)</h3>
            <p className="text-[11px] text-gray-500 font-medium -mt-1">2장 이상 업로드 시 <b>단체컷 한 장</b>으로 출력됩니다.</p>
            <div className="grid grid-cols-3 gap-2" onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleProductUpload(e.dataTransfer.files); }}>
              {Array.from({ length: 6 }).map((_, idx) => {
                const img = productImages[idx];
                if (img) {
                  return (
                    <div key={idx} className="aspect-square border border-black bg-white relative group">
                      <img src={img} className="w-full h-full object-contain p-1" alt={`Product ${idx+1}`} />
                      <button onClick={() => removeProductAt(idx)} className="absolute -top-1.5 -right-1.5 bg-black rounded-full text-white p-0.5 hover:bg-gray-800 z-10"><X className="w-3 h-3" /></button>
                      <span className="absolute bottom-0 left-0 bg-black text-white text-[9px] font-bold px-1 py-0.5">{idx + 1}</span>
                    </div>
                  );
                }
                const isNextSlot = idx === productImages.length;
                return (
                  <div
                    key={idx}
                    onClick={() => isNextSlot && document.getElementById('product-upload').click()}
                    className={`aspect-square border-2 border-dashed bg-white flex flex-col items-center justify-center transition-colors ${isNextSlot ? 'border-gray-400 hover:border-black cursor-pointer' : 'border-gray-200 opacity-50 cursor-not-allowed'}`}
                  >
                    {isNextSlot ? <UploadCloud className="w-5 h-5 text-gray-400 mb-1" /> : <Plus className="w-4 h-4 text-gray-300" />}
                    <span className={`text-[10px] font-bold ${isNextSlot ? 'text-gray-500' : 'text-gray-300'}`}>{idx + 1}</span>
                  </div>
                );
              })}
            </div>
            <input id="product-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => { handleProductUpload(e.target.files); e.target.value = ''; }} />
          </div>

          {/* 1. Product Detail Cuts (Label & Fabric Close-ups) */}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold uppercase text-black border-b-2 border-black pb-1">1. 디테일 컷 <span className="text-gray-500 font-medium normal-case">(라벨·원단 클로즈업, 최대 3장)</span></h3>
            <p className="text-[11px] text-gray-500 font-medium -mt-1">라벨 텍스트·원단 조직·재봉선·지퍼/단추 등 근접 촬영 이미지. <b>라벨과 원단을 픽셀 단위로 보존</b>하는 데 사용됩니다.</p>
            <div className="flex gap-2 items-start bg-white border border-gray-300 p-3 min-h-[90px]" onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleDetailCutUpload(e.dataTransfer.files); }}>
              {productDetailImages.map((img, idx) => (
                <div key={idx} className="relative w-20 h-20 border border-black shrink-0 bg-white">
                  <img src={img} className="w-full h-full object-cover" alt={`Detail ${idx+1}`} />
                  <button onClick={() => removeDetailAt(idx)} className="absolute -top-1.5 -right-1.5 bg-black rounded-full text-white p-0.5 hover:bg-gray-800"><X className="w-3 h-3"/></button>
                  <span className="absolute bottom-0 left-0 bg-black text-white text-[9px] font-bold px-1">{idx+1}</span>
                </div>
              ))}
              {productDetailImages.length < 3 && (
                <div onClick={() => document.getElementById('product-detail-upload').click()} className="w-20 h-20 border-2 border-dashed border-gray-300 bg-gray-50 cursor-pointer flex flex-col items-center justify-center shrink-0 hover:border-black transition-colors">
                  <Plus className="w-4 h-4 text-gray-400 mb-0.5"/>
                  <span className="text-[9px] font-bold text-gray-500 text-center leading-tight">디테일<br/>추가</span>
                </div>
              )}
              <input id="product-detail-upload" type="file" multiple className="hidden" accept="image/*" onChange={(e) => { handleDetailCutUpload(e.target.files); e.target.value = ''; }} />
            </div>
          </div>

          {/* 2. Background Selection */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-bold uppercase text-black border-b-2 border-black pb-1">2. 배경 선택</h3>
            <div className="grid grid-cols-4 gap-2">
                {bgOptions.map(bg => (
                    <button key={bg.id} onClick={() => setSelectedBg(bg.id)} className={`p-2 text-center border-2 transition-all ${selectedBg === bg.id ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                        <div className="text-xs font-bold break-keep">{bg.label}</div>
                    </button>
                ))}
            </div>
            {/* Custom Background Upload Area */}
            {selectedBg === 'custom' && (
                <div className="mt-2 p-3 bg-white border border-black rounded-sm">
                    <p className="text-[11px] font-bold text-black mb-2 uppercase">합성할 배경 이미지를 업로드하세요</p>
                    <div onClick={() => document.getElementById('custom-bg-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'customBg'); }} className="h-24 border border-dashed border-gray-300 hover:border-black bg-gray-50 cursor-pointer flex items-center justify-center relative">
                        {customBgImage ? <img src={customBgImage} className="w-full h-full object-cover opacity-80" alt="Custom BG" /> : <div className="text-center"><ImageIcon className="w-5 h-5 text-gray-400 mx-auto mb-1"/><span className="text-[10px] text-gray-500 font-bold">클릭하여 배경 추가</span></div>}
                        <input id="custom-bg-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'customBg')} />
                    </div>
                </div>
            )}
          </div>

          {/* 2. Lighting Selection */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-bold uppercase text-black border-b-2 border-black pb-1">3. 조명 질감 선택</h3>
            <div className="grid grid-cols-4 gap-2">
                {lightingOptions.map(light => (
                    <button key={light.id} onClick={() => setSelectedLighting(light.id)} className={`p-3 text-center border-2 transition-all ${selectedLighting === light.id ? 'border-black bg-black text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-400'}`}>
                        <div className="text-xs font-bold break-keep">{light.label}</div>
                    </button>
                ))}
            </div>
          </div>

          {/* 3. Mood Reference Image (Optional) */}
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-bold uppercase text-black border-b-2 border-black pb-1">4. 무드 레퍼런스 (선택)</h3>
            <p className="text-[11px] text-gray-500 font-medium -mt-1">레퍼런스의 <b>제품 배치를 거의 그대로 카피</b>하고, 색감·톤도 함께 반영합니다. (제품 자체는 업로드된 원본만 사용)</p>
            <div onClick={() => document.getElementById('mood-ref-upload').click()} onDragOver={e => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleImageUpload(e.dataTransfer.files[0], 'moodRef'); }} className="h-40 border-2 border-dashed border-gray-400 bg-white hover:border-black cursor-pointer flex items-center justify-center relative transition-colors overflow-hidden">
              {moodReferenceImage ? (
                <>
                  <img src={moodReferenceImage} className="w-full h-full object-contain p-2" alt="Mood Reference" />
                  <button onClick={(e) => { e.stopPropagation(); setMoodReferenceImage(null); }} className="absolute top-2 right-2 p-1.5 bg-black text-white rounded-full hover:bg-gray-800 z-10"><X className="w-4 h-4"/></button>
                </>
              ) : (
                <div className="text-center p-4 text-gray-400"><UploadCloud className="w-7 h-7 mx-auto mb-1" /><p className="font-bold text-xs uppercase">무드 레퍼런스 업로드</p><p className="text-[10px] mt-1 text-gray-400">예) 분위기 참고용 화보, 광고컷</p></div>
              )}
              <input id="mood-ref-upload" type="file" className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e.target.files[0], 'moodRef')} />
            </div>
          </div>

          {/* 4. Custom Prompt / Additional Comments */}
          <div className="flex flex-col gap-2 pt-2">
            <h3 className="text-sm font-bold uppercase text-black border-b-2 border-black pb-1">5. 추가 코멘트 (선택)</h3>
            <div className="flex flex-wrap gap-2 mb-1">
              {productSnippets.map(s => (
                <button key={s} onClick={() => appendPromptSnippet(s, setPrompt)} className="text-[11px] font-bold px-2 py-1 bg-gray-100 border border-gray-200 hover:bg-gray-200 text-gray-700 transition-colors">
                  + {s}
                </button>
              ))}
            </div>
            <textarea
                value={prompt || ''}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full h-24 p-3 border-2 border-gray-200 text-sm focus:border-black outline-none bg-white font-medium resize-none transition-colors"
                placeholder="예: 구겨진 부분을 반듯하게 정돈해주세요. 그림자를 더 길게 빼주세요.&#13;&#10;(입력하지 않으면 원본의 구겨짐/형태가 그대로 유지됩니다)"
            />
          </div>

          <div className="pb-10"></div> {/* Scroll spacing padding */}
        </div>

        {/* Generate Action Area Fixed Bottom */}
        <div className="p-5 border-t border-black bg-white sticky bottom-0">
            <button onClick={handleGenerate} disabled={isGenerating || productImages.length === 0} className={`w-full text-white py-4 font-bold text-base uppercase transition-opacity flex items-center justify-center gap-2 ${generatedImage ? 'bg-gray-800 hover:bg-black' : 'bg-black hover:bg-gray-800'} disabled:opacity-50`}>
                {isGenerating ? (
                    <><Loader2 className="w-5 h-5 animate-spin" /> 제작 중...</>
                ) : (
                    <><Sparkles className="w-5 h-5 text-white" /> {generatedImage ? '다른 느낌으로 재생성' : '제품컷 생성하기'}</>
                )}
            </button>
        </div>
      </div>

      {/* Right Panel: Large Result Display */}
      <div className="flex-1 bg-gray-100 flex flex-col relative">
         <div className="h-16 px-6 border-b border-black bg-white shrink-0 flex justify-between items-center">
             <h2 className="text-xl font-black uppercase tracking-tighter flex items-center gap-2 text-black"><CheckCircle2 className="w-6 h-6"/> Output Result</h2>
             {generatedImage && (
                 <div className="flex gap-2">
                     <button onClick={handleDownloadImage} className="w-full bg-black text-white px-4 py-2 text-sm font-bold uppercase hover:bg-gray-800 flex items-center gap-2"><Download className="w-4 h-4"/> 다운로드 (로컬 저장)</button>
                 </div>
             )}
         </div>

         <div className="flex-1 p-8 flex items-center justify-center relative overflow-hidden">
            {generatedImage ? (
                <div className="w-full h-full flex items-center justify-center bg-transparent cursor-pointer group relative" onClick={() => setShowZoomModal(true)}>
                    <img src={generatedImage} className="max-w-full max-h-full object-contain shadow-2xl bg-white" alt="Generated Product Shot" />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/5 pointer-events-none">
                        <Maximize2 className="w-12 h-12 text-black/50 drop-shadow-md" />
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); handleDownloadImage(); }} title="다운로드" className="absolute top-3 right-3 z-20 bg-white/95 hover:bg-white border border-black p-2.5 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"><Download className="w-5 h-5 text-black" /></button>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center text-gray-400">
                    <Camera className="w-24 h-24 mb-4 opacity-20"/>
                    <h3 className="text-xl font-bold uppercase text-gray-400 mb-2">No Image Generated</h3>
                    <p className="text-base font-medium">좌측 컨트롤에서 원본 이미지를 업로드하고 옵션을 선택한 뒤 생성 버튼을 누르세요.</p>
                </div>
            )}
         </div>
      </div>

      <ImageViewerModal isOpen={showZoomModal} onClose={() => setShowZoomModal(false)} imageSrc={generatedImage} />
    </div>
  );
};

const UploadModal = ({ isOpen, onClose, onUpload, uploadSettings, setUploadSettings, title = "대량 업로드" }) => {
  const [files, setFiles] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
      if (isOpen) {
          if(uploadSettings.initialFiles?.length > 0) setFiles(uploadSettings.initialFiles);
          else setFiles([]);
      }
  }, [isOpen, uploadSettings.initialFiles]);

  const handleFileChange = (e) => {
      const newFiles = Array.from(e.target.files).map(f => ({ fileObject: f, name: f.name, preview: URL.createObjectURL(f) }));
      setFiles(prev => [...prev, ...newFiles]);
      e.target.value = '';
  };

  const handleConfirm = async () => {
    if (files.length === 0) return;
    setIsUploading(true);
    const processed = [];
    try {
        for (const f of files) {
            let imgDataUrl = f.preview;

            if (f.fileObject) {
                const reader = new FileReader();
                imgDataUrl = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(f.fileObject);
                });
                imgDataUrl = await compressImage(imgDataUrl, 1024, 0.8);
            }

            processed.push({
                name: f.name.replace(/\.[^/.]+$/, "").toUpperCase(),
                image: imgDataUrl,
                prompt: f.prompt || ''
            });
        }
        await onUpload(processed);
    } catch (error) {
        console.error("Processing failed:", error);
    } finally {
        setIsUploading(false);
        setFiles([]);
        onClose();
    }
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-white/90 z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] max-w-3xl w-full p-8 animate-fade-in">
        <div className="flex justify-between items-center mb-8 pb-4 border-b border-black"><h3 className="text-2xl font-black text-black uppercase tracking-tighter flex items-center gap-3"><UploadCloud className="w-6 h-6" /> {title}</h3><button onClick={onClose}><X className="w-6 h-6" /></button></div>
        <div className="flex flex-col md:flex-row gap-8">
          <div className="w-full md:w-1/2">
            {files.length > 0 ? ( <div className="relative border border-black bg-gray-50 aspect-[3/4] p-4 group overflow-y-auto"><div className="flex flex-col gap-2">{files.map((f, i) => (<div key={i} className="flex gap-2 items-center bg-white border border-gray-200 p-2"><img src={f.preview} className="w-12 h-12 object-cover border border-gray-200" alt="Preview" /><div className="flex-1 flex flex-col"><input type="text" value={f.name} onChange={(e) => {const u=[...files]; u[i].name=e.target.value; setFiles(u);}} className="w-full text-xs border-b border-gray-300 focus:border-black outline-none p-1 font-bold" /></div></div>))}</div></div> ) : ( <div onClick={() => fileInputRef.current.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const newFiles = Array.from(e.dataTransfer.files).map(f => ({ fileObject: f, name: f.name, preview: URL.createObjectURL(f) })); setFiles(prev => [...prev, ...newFiles]); }} className="border-2 border-dashed aspect-[3/4] flex flex-col items-center justify-center p-4 cursor-pointer hover:bg-gray-50"><FileUp className="w-12 h-12 mb-4 text-gray-400" /><p className="text-sm font-bold">이미지 드래그 앤 드롭</p></div> )}
            <input type="file" multiple ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
          </div>
          <div className="w-full md:w-1/2 flex flex-col gap-6">
            <div><label className="block text-xs font-bold mb-2">브랜드 적용</label><select value={uploadSettings.brand} onChange={e => setUploadSettings({ ...uploadSettings, brand: e.target.value })} className="w-full p-3 border border-black text-sm font-bold bg-white">{FIXED_BRANDS.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
            <div className="mt-auto flex gap-4 pt-4"><button onClick={onClose} className="flex-1 py-4 border border-black font-bold text-sm">취소</button><button onClick={handleConfirm} disabled={files.length === 0 || isUploading} className="flex-1 py-4 bg-black text-white font-bold text-sm">{isUploading ? '업로드 중...' : '업로드'}</button></div>
          </div>
        </div>
      </div>
    </div>
  );
};

const DeleteConfirmModal = ({ isOpen, onClose, onConfirm }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-white/90 z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] max-w-sm w-full p-8 text-center animate-fade-in">
        <AlertTriangle className="w-12 h-12 text-black mx-auto mb-4" /><h3 className="text-xl font-black uppercase mb-2">삭제 확인</h3><p className="text-sm text-gray-600 mb-6">정말로 삭제하시겠습니까?</p>
        <div className="flex gap-4"><button onClick={onClose} className="flex-1 py-3 border border-black font-bold text-sm">취소</button><button onClick={onConfirm} className="flex-1 py-3 bg-black text-white border border-black font-bold text-sm">삭제</button></div>
      </div>
    </div>
  );
};

const SettingsModal = ({ isOpen, onClose, settings, onUpdate }) => {
  const [key, setKey] = useState(settings.apiKey || '');
  const [modelId, setModelId] = useState(settings.modelId || MODEL_OPTIONS.PRO);
  useEffect(() => {
    setKey(settings.apiKey || '');
    setModelId(settings.modelId || MODEL_OPTIONS.PRO);
  }, [settings.apiKey, settings.modelId, isOpen]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-white shadow-2xl max-w-md w-full p-8 animate-fade-in relative">
        <button onClick={onClose} className="absolute top-4 right-4"><X className="w-6 h-6" /></button>
        <h3 className="text-2xl font-black uppercase mb-6 flex items-center gap-2"><Settings className="w-6 h-6" /> 시스템 설정</h3>
        <div className="mb-6"><label className="block text-xs font-bold mb-2 uppercase flex items-center gap-2"><Key className="w-3 h-3" /> Google Gemini API Key</label><input type="password" value={key} onChange={e => setKey(e.target.value)} className="w-full p-3 border-2 border-black font-mono text-sm mb-2" placeholder="브라우저 및 클라우드에 자동 저장됩니다" /></div>
        <div className="mb-6">
          <label className="block text-xs font-bold mb-2 uppercase flex items-center gap-2"><Sparkles className="w-3 h-3" /> 이미지 모델</label>
          <div className="flex flex-col gap-2">
            <button onClick={() => setModelId(MODEL_OPTIONS.PRO)} className={`w-full py-3 px-4 border-2 text-left transition-colors ${modelId === MODEL_OPTIONS.PRO ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300 hover:border-black'}`}>
              <div className="text-xs font-black uppercase">Pro <span className="text-[10px] font-medium normal-case opacity-70">(Flash Image — 고화질·정확도)</span></div>
              <div className={`text-[10px] mt-0.5 ${modelId === MODEL_OPTIONS.PRO ? 'text-gray-300' : 'text-gray-500'} font-mono`}>{MODEL_OPTIONS.PRO}</div>
            </button>
            <button onClick={() => setModelId(MODEL_OPTIONS.LITE)} className={`w-full py-3 px-4 border-2 text-left transition-colors ${modelId === MODEL_OPTIONS.LITE ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-300 hover:border-black'}`}>
              <div className="text-xs font-black uppercase">Lite <span className="text-[10px] font-medium normal-case opacity-70">(Flash Image Lite — 빠름·저비용)</span></div>
              <div className={`text-[10px] mt-0.5 ${modelId === MODEL_OPTIONS.LITE ? 'text-gray-300' : 'text-gray-500'} font-mono`}>{MODEL_OPTIONS.LITE}</div>
            </button>
          </div>
        </div>
        <div className="mb-8"><label className="block text-xs font-bold mb-2 uppercase flex items-center gap-2"><ImageIcon className="w-3 h-3" /> 이미지 해상도</label><div className="flex gap-2"><button onClick={() => onUpdate({ ...settings, highRes: false })} className={`flex-1 py-3 border-2 text-xs font-bold uppercase ${!settings.highRes ? 'bg-black text-white' : ''}`}>Standard</button><button onClick={() => onUpdate({ ...settings, highRes: true })} className={`flex-1 py-3 border-2 text-xs font-bold uppercase ${settings.highRes ? 'bg-black text-white' : ''}`}>Ultra (4K)</button></div></div>
        <button onClick={() => { onUpdate({ ...settings, apiKey: key, modelId }); onClose(); }} className="w-full bg-black text-white py-4 font-bold uppercase hover:opacity-80">설정 저장</button>
      </div>
    </div>
  );
};

const Sidebar = ({ currentView, onNavigate, onExport, onImport, isProcessing }) => {
  const importInputRef = useRef(null);
  const handleImportClick = (e) => {
      if (isProcessing) return;
      const file = e.target.files[0];
      if (file) {
          onImport(file);
      }
      e.target.value = '';
    };

  return (
    <aside className="w-20 lg:w-72 bg-white border-r border-black flex flex-col hidden sm:flex shrink-0 h-full z-20">
      <div className="p-6 flex items-center gap-3 shrink-0 border-b border-black h-16"><div className="w-8 h-8 bg-black rounded-none flex items-center justify-center"><Palette className="text-white w-5 h-5" /></div><span className="font-extrabold text-xl text-black hidden lg:block tracking-tighter uppercase">Brand Studio</span></div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <button onClick={() => onNavigate('lookbook')} className={`w-full flex items-center gap-4 px-6 py-4 border-b border-black transition-all group ${currentView === 'lookbook' || currentView === 'generator' ? 'bg-black text-white' : 'text-black hover:bg-gray-100'}`}><BookOpen className={currentView === 'lookbook' || currentView === 'generator' ? 'text-white' : 'text-black'} /><span className="font-bold text-sm hidden lg:block flex-1 text-left tracking-wider uppercase">LOOKBOOK</span></button>
        <button onClick={() => onNavigate('fitting')} className={`w-full flex items-center gap-4 px-6 py-4 border-b border-black transition-all group ${currentView === 'fitting' ? 'bg-black text-white' : 'text-black hover:bg-gray-100'}`}><Layers className={currentView === 'fitting' ? 'text-white' : 'text-black'} /><span className="font-bold text-sm hidden lg:block flex-1 text-left tracking-wider uppercase">FITTING ROOM</span></button>
        <button onClick={() => onNavigate('product_studio')} className={`w-full flex items-center gap-4 px-6 py-4 border-b border-black transition-all group ${currentView === 'product_studio' ? 'bg-black text-white' : 'text-black hover:bg-gray-100'}`}><Package className={currentView === 'product_studio' ? 'text-white' : 'text-black'} /><span className="font-bold text-sm hidden lg:block flex-1 text-left tracking-wider uppercase">PRODUCT SHOT</span></button>
      </div>
      <div className="p-4 border-t border-black shrink-0 bg-gray-50">
        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-1"><Database className="w-3 h-3" /> 데이터 관리</h4>
        <div className="flex gap-2">
          <button onClick={onExport} disabled={isProcessing} className="flex-1 bg-white border border-black py-2 text-[10px] font-bold uppercase hover:bg-black hover:text-white transition-colors flex items-center justify-center gap-1 disabled:opacity-50"><Download className="w-3 h-3" /> 내보내기</button>
          <button onClick={() => importInputRef.current.click()} disabled={isProcessing} className="flex-1 bg-white border border-black py-2 text-[10px] font-bold uppercase hover:bg-black hover:text-white transition-colors flex items-center justify-center gap-1 disabled:opacity-50"><FilePlus className="w-3 h-3" /> 불러오기</button>
          <input type="file" accept=".json" ref={importInputRef} onChange={handleImportClick} className="hidden" />
        </div>
      </div>
    </aside>
  );
};

export default function App() {
  const [currentView, setCurrentView] = useState('lookbook');
  const [selectedReference, setSelectedReference] = useState(null);
  const [editingReference, setEditingReference] = useState(null);

  const [lookbookBrand, setLookbookBrand] = useState('All');
  const [notification, setNotification] = useState(null);

  const user = useAuth();
  const [settings, setSettings] = useSettings(user);
  const { references, loading, saveReference, deleteReference, importReferences } = useAppData(user);
  const [isGlobalProcessing, setIsGlobalProcessing] = useState(false);

  const [modals, setModals] = useState({ uploadRef: false, delete: false, settings: false });
  const [uploadSettings, setUploadSettings] = useState({ brand: 'EZ' });

  useEffect(() => {
    if (DEFAULT_API_KEY && !settings.apiKey) {
        setSettings(prev => ({ ...prev, apiKey: DEFAULT_API_KEY }));
    }
  }, []);

  const showNotification = (msg, type = 'success') => {
    setNotification({ message: String(msg), type });
    setTimeout(() => setNotification(null), 3000);
  };

  const handleUploadReference = async (fileList) => {
    if (!user) return showNotification("시스템 초기화 중입니다.", "error");
    setIsGlobalProcessing(true);
    try {
      let completed = 0;
      for (const fileData of fileList) {
        await saveReference({ name: fileData.name, image: fileData.image, brand: uploadSettings.brand, prompt: '' });
        completed++;
        await delay(500);
      }
      showNotification(`${completed}개 레퍼런스 등록 완료`);
      setModals(p => ({ ...p, uploadRef: false }));
    } catch(e) { showNotification("업로드 오류 발생", "error"); }
    finally { setIsGlobalProcessing(false); }
  };

  const handleDeleteReference = async (id) => {
    try { await deleteReference(id); showNotification("레퍼런스 삭제됨"); } catch(e) { showNotification("삭제 실패", "error"); }
  };

  const handleReferenceUpdate = async (d) => { await saveReference(d, true, d.id); setEditingReference(null); showNotification("레퍼런스가 수정되었습니다."); };
  const handleReferenceDeleteWithModal = async (id) => { await deleteReference(id); setEditingReference(null); showNotification("레퍼런스가 삭제되었습니다."); };

  const handleExportData = () => {
      if (!references.length) return showNotification("내보낼 데이터가 없습니다.", "error");
      const exportData = {
          references,
          exportedAt: new Date().toISOString()
      };
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", `brand_studio_backup_${new Date().toISOString().slice(0,10)}.json`);
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
      showNotification("데이터 내보내기 완료");
  };

  const handleImportData = async (file) => {
      if (!file) return;
      setIsGlobalProcessing(true);
      const reader = new FileReader();
      reader.onload = async (e) => {
          try {
              const data = JSON.parse(e.target.result);
              let rCount = 0;
              if (data.references && Array.isArray(data.references)) {
                  await importReferences(data.references);
                  rCount = data.references.length;
              }
              showNotification(`복원 완료: 레퍼런스 ${rCount}개`);
          } catch (err) {
              console.error(err);
              showNotification("파일 형식 오류 또는 손상된 파일입니다.", "error");
          } finally {
              setIsGlobalProcessing(false);
          }
      };
      reader.readAsText(file);
  };

  return (
    <div className="flex h-screen bg-white text-black font-sans overflow-hidden">
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #e5e7eb; border-radius: 20px; }
        .custom-scrollbar:hover::-webkit-scrollbar-thumb { background-color: #d1d5db; }
        .animate-fade-in { animation: fadeIn 0.3s ease-in-out; }
        .animate-slide-up { animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>

      <Sidebar
        currentView={currentView}
        onNavigate={(view) => setCurrentView(view)}
        onExport={handleExportData}
        onImport={handleImportData}
        isProcessing={isGlobalProcessing}
      />
      <main className="flex-1 flex flex-col overflow-hidden relative min-w-0 bg-white">
        <header className="h-16 bg-white border-b border-black flex items-center justify-between px-6 shrink-0 z-10">
          <div className="flex items-center gap-4">
            {currentView === 'generator' ? (
              <button onClick={() => setCurrentView('lookbook')} className="flex items-center gap-2 hover:opacity-70"><ChevronLeft className="w-5 h-5" /> <span className="hidden sm:inline font-bold uppercase">레퍼런스 목록으로 돌아가기</span></button>
            ) : (
              <div className="font-extrabold text-lg uppercase flex items-center gap-2">
                {currentView === 'fitting' ? 'FITTING ROOM' : currentView === 'product_studio' ? 'PRODUCT STUDIO' : 'LOOKBOOK STUDIO'}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <button onClick={() => setModals(p => ({ ...p, settings: true }))} className={`flex items-center gap-2 px-3 py-1.5 text-xs font-bold border rounded-full transition-colors ${settings.apiKey ? 'bg-black text-white border-black' : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200 hover:text-black'}`}><Key className="w-3 h-3" /><span className="hidden sm:inline">{settings.apiKey ? 'API Key 설정됨' : 'API Key 설정'}</span></button>
          </div>
        </header>
        <div className="flex-1 overflow-hidden relative flex flex-col">

          {(currentView === 'lookbook' || currentView === 'generator') && (
            <div className="w-full h-full flex flex-col relative">
                <LookbookHeader
                    selectedBrand={lookbookBrand}
                    onSelectBrand={(b) => {
                        setLookbookBrand(b);
                        if (currentView === 'generator') setCurrentView('lookbook');
                    }}
                    onAddReference={() => { setUploadSettings({ brand: 'EZ', initialFiles: [] }); setModals(p => ({ ...p, uploadRef: true })); }}
                />
                <div className="flex-1 overflow-hidden relative">
                     {currentView === 'lookbook' && (
                        <LookbookDashboardGrid
                            references={references}
                            selectedBrand={lookbookBrand}
                            onSelectReference={(r) => { setSelectedReference(r); setCurrentView('generator'); }}
                            onDeleteReference={handleDeleteReference}
                            onEditReference={setEditingReference}
                        />
                     )}
                     {currentView === 'generator' && selectedReference && (
                        <LookbookGenerator reference={selectedReference} references={references} onBack={() => setCurrentView('lookbook')} settings={settings} showNotification={showNotification} />
                     )}
                </div>
            </div>
          )}

           {currentView === 'fitting' && (
            <FittingRoomGenerator settings={settings} showNotification={showNotification} />
          )}

          {currentView === 'product_studio' && (
            <ProductStudioGenerator settings={settings} showNotification={showNotification} />
          )}
        </div>
        {notification && (
          <div className={`absolute bottom-6 right-6 px-6 py-4 border-2 border-black shadow-lg z-[999] animate-slide-up flex items-center gap-2 ${notification.type === 'error' ? 'bg-white text-black' : 'bg-black text-white'}`}>
            {notification.type === 'error' ? <XCircle className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
            <span className="font-bold text-sm uppercase">{notification.message}</span>
          </div>
        )}
      </main>

      {/* Modals */}
      <UploadModal isOpen={modals.uploadRef} onClose={() => setModals(p => ({ ...p, uploadRef: false }))} onUpload={handleUploadReference} uploadSettings={uploadSettings} setUploadSettings={setUploadSettings} title="레퍼런스 등록 (LOOKBOOK)" />
      <SettingsModal isOpen={modals.settings} onClose={() => setModals(p => ({ ...p, settings: false }))} settings={settings} onUpdate={setSettings} />

      {/* Detail Modals */}
      <ReferenceDetailModal isOpen={!!editingReference} onClose={() => setEditingReference(null)} reference={editingReference} onSave={handleReferenceUpdate} onDelete={handleReferenceDeleteWithModal} />
    </div>
  );
}
