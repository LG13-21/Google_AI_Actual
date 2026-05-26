import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Scale, Send, FileText, CheckCircle2, AlertCircle, RefreshCcw, Loader2, 
  Sparkles, Copy, Check, Upload, X, FileJson, Archive, Download, Eye, 
  FileDown, Trash2, FolderArchive, RotateCcw, ListFilter, History,
  LayoutGrid, Layers, ShieldCheck, Gauge, Scissors, Diff, Paperclip, Plus,
  LogOut, LogIn, Database, FileCode, Github
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { reviewCourtRequest } from './services/gemini';
import { cn } from './lib/utils';
import { auth, db, googleProvider, signInWithPopup, GoogleAuthProvider } from './lib/firebase';
import { GoogleDriveService, type GDriveFile } from './services/drive';
import { GitHubService, type GitHubFile } from './services/github';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { 
  collection, doc, getDoc, getDocs, setDoc, updateDoc, 
  deleteDoc, query, where, onSnapshot, writeBatch,
  getDocFromServer
} from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw to avoid crashing the whole app, but we log it
}

interface FileEntry {
  id: string;
  driveId?: string; // Reference to Google Drive file
  githubPath?: string; // Reference to GitHub path
  name: string;
  type: string;
  category: 'MAIN' | 'ATTACH' | 'SUPPORT' | 'SYSTEM' | string;
  isUploaded?: boolean;
  isArchived?: boolean;
  timestamp: number;
  batchId?: string;
  version?: string;
  caseId?: string;
  content?: string; 
  insight?: string; // Pre-analysis result
  indexStatus?: 'IDLE' | 'INDEXING' | 'DONE' | 'ERROR';
}

interface CaseRecord {
  id: string;
  name: string;
  nr: string;
  activeVersion: string;
}

interface AuditTask {
  id: string;
  files: string[];
  supportFiles: string[];
  pillars: string[];
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
  timestamp: number;
  result?: string;
  isNotified?: boolean;
  version?: string;
}

interface VersionRecord {
  id: string;
  version: string;
  text: string;
  timestamp: number;
  selectedFiles: string[];
  selectedPillars: string[];
}

export default function App() {
  const [inputText, setInputText] = useState('');
  const [currentVersion, setCurrentVersion] = useState('F15.5');
  const [history, setHistory] = useState<VersionRecord[]>([]);
  const [compareVersionIds, setCompareVersionIds] = useState<string[]>([]);
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'MD' | 'JSON' | 'HTML'>('HTML');
  const [error, setError] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<FileEntry[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [supportFileIds, setSupportFileIds] = useState<string[]>([]);
  const [selectedPillarIds, setSelectedPillarIds] = useState<string[]>(['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14']);
  const [fileSearch, setFileSearch] = useState('');
  const [versionFilter, setVersionFilter] = useState<'ALL' | 'CURRENT' | 'ORPHAN' | string>('ALL');
  const [fileSortBy, setFileSortBy] = useState<'id' | 'name' | 'type' | 'date' | 'batch' | 'ORDER'>('ORDER');
  const [showArchived, setShowArchived] = useState(false);
  const [auditQueue, setAuditQueue] = useState<AuditTask[]>([]);
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [queueStrategy, setQueueStrategy] = useState<'COMBINE' | 'PER_FILE' | 'CROSS'>('COMBINE');
  const [appMode, setAppMode] = useState<'AUDIT' | 'COMPOSE'>('AUDIT');
  const [uploadBatchId, setUploadBatchId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showAtoms, setShowAtoms] = useState(false);
  const [notes, setNotes] = useState('');
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [showCaseModal, setShowCaseModal] = useState(false);
  const [newCaseData, setNewCaseData] = useState({ name: '', nr: '' });
  const [selectionMode, setSelectionMode] = useState<'FILES' | 'VERSIONS'>('FILES');
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [currentProcessingId, setCurrentProcessingId] = useState<string | null>(null);
  const [gitContext, setGitContext] = useState('https://github.com/LG13-21/lg13-build-from-atoms');
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);
  const [driveToken, setDriveToken] = useState<string | null>(localStorage.getItem('juris_drive_token'));
  const [isDriveEnabled, setIsDriveEnabled] = useState(localStorage.getItem('is_drive_enabled') === 'true');
  const [isSyncingDrive, setIsSyncingDrive] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [driveQuota, setDriveQuota] = useState<{ limit: number, usage: number } | null>(null);
  const [isDrivePickerOpen, setIsDrivePickerOpen] = useState(false);
  const [driveFolderFiles, setDriveFolderFiles] = useState<GDriveFile[]>([]);
  const [isDrivePickerLoading, setIsDrivePickerLoading] = useState(false);

  // GitHub State
  const [gitHubToken, setGitHubToken] = useState<string | null>(localStorage.getItem('juris_github_token'));
  const [isGitHubEnabled, setIsGitHubEnabled] = useState(localStorage.getItem('is_github_enabled') === 'true');
  const [isSyncingGitHub, setIsSyncingGitHub] = useState(false);
  const [gitHubRepo, setGitHubRepo] = useState(localStorage.getItem('juris_github_repo') || 'LG13-21/legal-ship-2026');

  // Fetch Drive Quota
  useEffect(() => {
    if (isDriveEnabled && driveToken) {
      const fetchQuota = async () => {
        try {
          const drive = new GoogleDriveService(driveToken);
          const about = await drive.getAbout();
          if (about.storageQuota) {
            setDriveQuota({
              limit: parseInt(about.storageQuota.limit),
              usage: parseInt(about.storageQuota.usage)
            });
          }
        } catch (e: any) {
          console.error('Failed to fetch Drive quota:', e);
          if (e.message?.includes('Google Drive API has not been used')) {
             console.error('ACTION REQUIRED: Enable Drive API at https://console.developers.google.com/apis/api/drive.googleapis.com/overview');
          }
        }
      };
      fetchQuota();
    }
  }, [isDriveEnabled, driveToken]);

  const isResetting = useRef(false);
  const isLoaded = useRef(false);
  const stopRequestedRef = useRef(false);

  // Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    // 1. Gesture-First: Try to open the popup BEFORE any state changes
    // This preserves the "User Gesture" which browsers use to allow popups.
    console.log('--- Auth Sequence: Gesture Trigger ---');
    
    const loginTimeout = setTimeout(() => {
      if (!isAuthLoading) {
        confirm('Přihlášení trvá příliš dlouho. \n\nMožné příčiny:\n1. Prohlížeč blokuje komunikaci v iFramu.\n2. Okno je schované za jiným oknem.\n\nTIP: Klikněte na tlačítko "Otevřít v novém okně" v pravém horním rohu lišty AI Studia a zkuste to tam.');
      }
    }, 45000);

    try {
      // 1. Gesture-First: Try to open the popup BEFORE any state changes
      // This preserves the "User Gesture" which browsers use to allow popups.
      console.log('--- Auth Sequence: Gesture Trigger ---');
      setIsAuthLoading(true);
      
      // Attempt login
      const result = await signInWithPopup(auth, googleProvider);
      
      // Successfully got a result, now we can update loading states
      clearTimeout(loginTimeout);
      
      const credential = GoogleAuthProvider.credentialFromResult(result);
      
      if (credential?.accessToken) {
        setDriveToken(credential.accessToken);
        localStorage.setItem('juris_drive_token', credential.accessToken);
        setIsDriveEnabled(true);
        localStorage.setItem('is_drive_enabled', 'true');
        console.log('Drive login successful, token stored.');
        alert('Google Drive úspěšně připojen.');
      } else {
        console.warn('Login successful but no credential/token found.');
        alert('Přihlášení proběhlo, ale nepodařilo se získat přístup k Google Drive. Zkuste to prosím znovu.');
      }
    } catch (e: any) {
      clearTimeout(loginTimeout);
      console.error('CRITICAL LOGIN ERROR:', e);
      
      let errorMsg = `Chyba přihlášení: ${e.message}`;
      
      if (e.code === 'auth/popup-closed-by-user') {
        errorMsg = 'Okno bylo zavřeno dříve, než se přihlášení stihlo dokončit.';
      } else if (e.code === 'auth/unauthorized-domain') {
        const domain = window.location.origin.replace('https://', '');
        errorMsg = `TATO DOMÉNA NENÍ POVOLENA VE FIREBASE.\n\nV konzoli Firebase (Authentication -> Settings -> Authorized Domains) přidejte:\n${domain}\n\nBez tohoto kroku nebude login v iFramu fungovat.`;
      } else if (e.code === 'auth/popup-blocked') {
        errorMsg = 'Prohlížeč zablokoval vyskakovací okno. Povolte prosím vyskakovací okna pro tuto adresu.';
      } else if (e.code === 'auth/network-request-failed') {
        errorMsg = 'Chyba sítě. Zkontrolujte připojení nebo zkuste vypnout AdBlock.';
      } else if (e.code === 'auth/internal-error') {
        errorMsg = 'Interní chyba Firebase. Zkuste aplikaci otevřít v plném okně (čtvereček s šipkou vpravo nahoře).';
      }
      
      alert(`${errorMsg}\n\nŘEŠENÍ: Klikněte na ikonu čtverce s šipkou ("Otevřít v novém okně") vpravo nahoře v liště AI Studia. Tam přihlášení funguje vždy.`);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      window.location.reload();
    } catch (e) {
      console.error('Logout failed:', e);
    }
  };

  // Test Connection
  useEffect(() => {
    if (user) {
      const testConnection = async () => {
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (error) {
          if(error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Please check your Firebase configuration.");
          }
        }
      };
      testConnection();
    }
  }, [user]);

  // Cloud Sync Logic
  useEffect(() => {
    if (!user) return;

    const loadFromCloud = async () => {
      const uid = user.uid;
      try {
        const filesSnap = await getDocs(collection(db, `users/${uid}/files`));
        const queueSnap = await getDocs(collection(db, `users/${uid}/queue`));
        const historySnap = await getDocs(collection(db, `users/${uid}/history`));
        const casesSnap = await getDocs(collection(db, `users/${uid}/cases`));
        const settingsSnap = await getDoc(doc(db, `users/${uid}/settings`, 'current'));

        if (!filesSnap.empty) setUploadedFiles(filesSnap.docs.map(d => d.data() as FileEntry));
        if (!queueSnap.empty) setAuditQueue(queueSnap.docs.map(d => d.data() as AuditTask));
        if (!historySnap.empty) setHistory(historySnap.docs.map(d => d.data() as VersionRecord));
        if (!casesSnap.empty) setCases(casesSnap.docs.map(d => d.data() as CaseRecord));
        
        if (settingsSnap.exists()) {
          const s = settingsSnap.data();
          if (s.currentCaseId) setCurrentCaseId(s.currentCaseId);
          if (s.currentVersion) setCurrentVersion(s.currentVersion);
          if (s.queueStrategy) setQueueStrategy(s.queueStrategy);
          if (s.gitContext) setGitContext(s.gitContext);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, 'initial_load');
      }
    };

    loadFromCloud();
  }, [user]);

  const syncToCloud = async (key: string, data: any) => {
    if (!user || !isLoaded.current || isResetting.current) return;
    setIsCloudSyncing(true);
    const uid = user.uid;
    
    try {
      if (key === 'juris_files') {
        const batch = writeBatch(db);
        data.forEach((f: FileEntry) => {
          batch.set(doc(db, `users/${uid}/files`, f.id), { ...f, userId: uid });
        });
        await batch.commit();
      } else if (key === 'juris_queue') {
        const batch = writeBatch(db);
        data.forEach((t: AuditTask) => {
          batch.set(doc(db, `users/${uid}/queue`, t.id), { ...t, userId: uid });
        });
        await batch.commit();
      } else if (key === 'juris_history') {
        const batch = writeBatch(db);
        data.forEach((h: VersionRecord) => {
          batch.set(doc(db, `users/${uid}/history`, h.id), { ...h, userId: uid });
        });
        await batch.commit();
      } else if (key === 'juris_cases') {
        const batch = writeBatch(db);
        data.forEach((c: CaseRecord) => {
          batch.set(doc(db, `users/${uid}/cases`, c.id), { ...c, userId: uid });
        });
        await batch.commit();
      } else {
        await setDoc(doc(db, `users/${uid}/settings`, 'current'), {
          currentCaseId,
          currentVersion,
          queueStrategy,
          gitContext,
          userId: uid
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, key);
    } finally {
      setIsCloudSyncing(false);
    }
  };

  const toggleSelectionMode = (mode: 'FILES' | 'VERSIONS') => {
    setSelectionMode(mode);
    setCompareVersionIds([]);
    setReviewResult(null);
  };
  
  // Auto-Archive Logic: Files older than 24h
  useEffect(() => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    setUploadedFiles(prev => prev.map(f => {
      if (!f.isArchived && (now - f.timestamp > oneDay)) {
        return { ...f, isArchived: true };
      }
      return f;
    }));
  }, []);
  
  // Case hierarchy
  const [cases, setCases] = useState<CaseRecord[]>([
    { id: 'C01', name: 'Hlavní Spis', nr: '2026/LG/13', activeVersion: 'V3.0.0' },
    { id: 'C_INBOUND', name: 'PŘÍCHOZÍ DOKUMENTY', nr: 'PENDING_UPLOAD', activeVersion: 'NEW' }
  ]);
  const [currentCaseId, setCurrentCaseId] = useState('C01');
  const [selectedBulkIds, setSelectedBulkIds] = useState<string[]>([]);

  // Persistence logic (Load once on mount)
  useEffect(() => {
    try {
      const savedFiles = localStorage.getItem('juris_files');
      const savedQueue = localStorage.getItem('juris_queue');
      const savedStrategy = localStorage.getItem('juris_strategy');
      const savedHistory = localStorage.getItem('juris_history');
      const savedCases = localStorage.getItem('juris_cases');
      const savedCaseId = localStorage.getItem('juris_current_case_id');
      const savedVersion = localStorage.getItem('juris_version');
      const savedGit = localStorage.getItem('juris_git_context');
      const savedGHToken = localStorage.getItem('juris_github_token');
      const savedGHRepo = localStorage.getItem('juris_github_repo');
      const savedGHEnabled = localStorage.getItem('is_github_enabled') === 'true';

      if (savedFiles) setUploadedFiles(JSON.parse(savedFiles));
      if (savedQueue) setAuditQueue(JSON.parse(savedQueue));
      if (savedStrategy) setQueueStrategy(savedStrategy as any);
      if (savedHistory) setHistory(JSON.parse(savedHistory));
      if (savedCases) setCases(JSON.parse(savedCases));
      if (savedCaseId) setCurrentCaseId(savedCaseId);
      if (savedVersion) setCurrentVersion(savedVersion);
      if (savedGit) setGitContext(savedGit);
      if (savedGHToken) setGitHubToken(savedGHToken);
      if (savedGHRepo) setGitHubRepo(savedGHRepo);
      if (savedGHEnabled) setIsGitHubEnabled(savedGHEnabled);
      
      // Mark as loaded after state updates are scheduled
      setTimeout(() => {
        isLoaded.current = true;
      }, 0);
    } catch (e) {
      console.error('Failed to restore session:', e);
      isLoaded.current = true; // Still mark as loaded to allow saving new data
    }
  }, []);

  const [storageError, setStorageError] = useState<string | null>(null);

  // Save changes to localStorage with size handling
  const safeSave = (key: string, value: string) => {
    if (!isLoaded.current || isResetting.current) return;
    try {
      // Logic for stripping heavy content if Drive is enabled to save space in localStorage
      let processedValue = value;
      if (key === 'juris_files') {
        try {
          const files: FileEntry[] = JSON.parse(value);
          // If Drive is enabled, be very aggressive about stripping content
          if (isDriveEnabled) {
            const slimFiles = files.map(f => {
              if (f.driveId && f.content && f.content.length > 500) {
                return { ...f, content: undefined }; 
              }
              return f;
            });
            processedValue = JSON.stringify(slimFiles);
          } else {
            // Even without Drive, if we are reaching limits, we might need to strip content
            // but for now we keep it unless it fails.
          }
        } catch (e) {
          console.error('SafeSave Parse Error:', e);
        }
      }

      localStorage.setItem(key, processedValue);
      if (storageError) setStorageError(null);
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
        console.warn(`Storage full for ${key}. Current size: ${value.length}`);
        setStorageError(`VYČERPÁNA KAPACITA PAMĚTI (${key}): Místo v prohlížeči je plné. Smažte nepotřebné soubory nebo zapněte Google Sync (Drive) pro uvolnění místa.`);
      }
    }
  };

  useEffect(() => { 
    safeSave('juris_files', JSON.stringify(uploadedFiles)); 
    if (user) syncToCloud('juris_files', uploadedFiles);
  }, [uploadedFiles]);
  
  useEffect(() => { 
    safeSave('juris_queue', JSON.stringify(auditQueue)); 
    if (user) syncToCloud('juris_queue', auditQueue);
  }, [auditQueue]);
  
  useEffect(() => { 
    safeSave('juris_strategy', queueStrategy); 
    if (user) syncToCloud('juris_strategy', queueStrategy);
  }, [queueStrategy]);
  
  useEffect(() => { 
    safeSave('juris_history', JSON.stringify(history)); 
    if (user) syncToCloud('juris_history', history);
  }, [history]);
  
  useEffect(() => { 
    safeSave('juris_cases', JSON.stringify(cases)); 
    if (user) syncToCloud('juris_cases', cases);
  }, [cases]);
  
  useEffect(() => { 
    safeSave('juris_current_case_id', currentCaseId); 
    if (user) syncToCloud('juris_current_case_id', currentCaseId);
  }, [currentCaseId]);
  
  useEffect(() => { 
    safeSave('juris_version', currentVersion); 
    if (user) syncToCloud('juris_version', currentVersion);
  }, [currentVersion]);
  
  useEffect(() => { 
    safeSave('juris_git_context', gitContext); 
    if (user) syncToCloud('juris_git_context', gitContext);
  }, [gitContext]);

  useEffect(() => {
    if (gitHubToken) localStorage.setItem('juris_github_token', gitHubToken);
    else localStorage.removeItem('juris_github_token');
  }, [gitHubToken]);

  useEffect(() => {
    localStorage.setItem('juris_github_repo', gitHubRepo || '');
  }, [gitHubRepo]);

  useEffect(() => {
    localStorage.setItem('is_github_enabled', isGitHubEnabled.toString());
  }, [isGitHubEnabled]);

  // Sync state to current snapshot in cases list
  useEffect(() => {
    if (currentCaseId && currentVersion) {
      setCases(prev => prev.map(c => c.id === currentCaseId ? { ...c, activeVersion: currentVersion } : c));
    }
  }, [currentVersion, currentCaseId]);
  
  const TECHNICAL_README = `# §LG13§ TECHNICAL ARCHITECTURE MANIFESTO v4.0
## Forenzní Právní Engine
Tento systém je navržen pro precizní audit a kompozici právních podání.

### GitHub (Ship Sync) Integrace:
- **Synchronizace z Repozitáře**: Aplikace umožňuje načítat soubory přímo z GitHub repozitáře (např. \`LG13-21/legal-ship-2026\`).
- **Personal Access Token**: Pro přístup k soukromým repozitářům zadejte svůj GitHub PAT v sekci nastavení.
- **Hierarchie**: Systém hledá soubory primárně ve složce \`LG13_Terminal_Data\` nebo v kořenovém adresáři.

### Google Drive (Google One) Integrace:
- **Automatické zálohování**: Pokud je aktivní Google Drive, soubory se automaticky ukládají do složky \`LG13_Terminal_Data\`.
- **Manuální nahrávání**: Soubory můžete do této složky nahrát i přímo přes Google Drive aplikaci nebo web.
- **Synchronizace**: Po manuálním nahrání klikněte na "Sync Google Drive" v aplikaci pro načtení nových souborů.

### Core Moduly:
1. **Atomic Parser**: Rozkládá dokumenty na argumentační atomy (Fakt-Právo-Důkaz).
2. **Relational Mapper**: Sleduje hierarchii Spis -> Verze -> Dokumenty.
3. **Cross-Reference Engine**: Verifikuje existenci příloh (P1, P2...) v reálném čase.

### Správa Souborů a Verzí:
- **Automatické přiřazení**: Soubory nahrané během aktivního spisu/verze jsou k nim automaticky připojeny.
- **Sirotčí soubory (ORPHAN)**: Pokud nahrajete soubory mimo kontext, použijte filtr "OSIŘELÉ SOUBORY".
- **Hromadné přiřazení**: Označte soubory a použijte "PŘIŘADIT K AKTUÁLNÍMU" v horní liště.
- **ZIP Upload**: Podporuje hromadné nahrávání uvnitř archivu.

### API & Integrace:
- **GitHub Sync (Concept)**: Protokol pro automatické nasazování verifikovaných draftů.
- **TLS 1.3 Encryption**: Veškerý přenos dat je šifrován na úrovni bankovních standardů.

### Právní Rámec:
Optimalizováno pro NOZ 2026, ZŘS po novelách 2025/2026.
`;

  const downloadTechnicalReadme = () => {
    const blob = new Blob([TECHNICAL_README], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'LG13_TECHNICAL_GUIDE.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleSelectAll = () => {
    // Check if all currently filtered files are already selected
    const allFilteredSelected = filteredFiles.length > 0 && 
                                filteredFiles.every(f => selectedBulkIds.includes(f.id));
    
    if (allFilteredSelected) {
      // If all are selected, remove only the filtered ones from selection
      const filteredIds = filteredFiles.map(f => f.id);
      setSelectedBulkIds(prev => prev.filter(id => !filteredIds.includes(id)));
    } else {
      // Otherwise, add all filtered files to selection (while keeping others)
      const newIds = filteredFiles.map(f => f.id).filter(id => !selectedBulkIds.includes(id));
      setSelectedBulkIds(prev => [...prev, ...newIds]);
    }
  };

  // Dynamic metrics for footer
  const [dynamicScore, setDynamicScore] = useState(98.2);
  const [dynamicRisk, setDynamicRisk] = useState('LEVEL_1');

  const resultRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Removed shadowed persistence logic

  const downloadReport = (taskId: string) => {
    const task = auditQueue.find(t => t.id === taskId);
    if (!task || !task.result) return;
    
    const blob = new Blob([task.result], { type: 'text/markdown;charset=utf-8' });
    saveAs(blob, `AUDIT_${task.version || ''}_${task.id}.md`);
  };

  const downloadAllResults = async (onlyToday = false) => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const tasksToExport = auditQueue.filter(t => {
      const isDone = t.status === 'done' && t.result;
      if (!isDone) return false;
      if (onlyToday) return t.timestamp >= startOfToday.getTime();
      return true;
    });

    if (tasksToExport.length === 0) {
      alert(onlyToday ? 'DNES NEBYLY DOKONČENY ŽÁDNÉ ÚLOHY.' : 'ŽÁDNÉ DOKONČENÉ ÚLOHY KE STAŽENÍ.');
      return;
    }

    try {
      const zip = new JSZip();
      tasksToExport.forEach(task => {
        const fileName = `AUDIT_${task.version || ''}_${task.id}.md`;
        zip.file(fileName, task.result!);
      });

      const content = await zip.generateAsync({ type: 'blob' });
      saveAs(content, onlyToday ? `AUDIT_TODAY_${new Date().toISOString().split('T')[0]}.zip` : `AUDIT_EXPORT_ALL.zip`);
    } catch (e) {
      console.error('ZIP Error:', e);
      alert('Chyba při vytváření ZIP archivu.');
    }
  };

  const printReport = () => {
    generatePDF();
  };

  const auditPillars = [
    { id: 'P01', name: 'Kontrola markerů', desc: 'Vyhledávání TBD/TODO značek', icon: <Eye size={12}/> },
    { id: 'P02', name: 'Relační synchronizace', desc: 'Soulad identifikace a rolí', icon: <RotateCcw size={12}/> },
    { id: 'P03', name: 'Detekce paradoxů', desc: 'Analýza časových a logických Update-Gaps', icon: <AlertCircle size={12}/> },
    { id: 'P04', name: 'Audit asymetrie', desc: 'Symetrie zkoumání obou stran', icon: <Scale size={12}/> },
    { id: 'P05', name: 'Cirkulární argumentace', desc: 'Detekce argumentačních smyček', icon: <RotateCcw size={12}/> },
    { id: 'P06', name: 'Heuristická integrita', desc: 'Validace citací (NOZ / ZŘS 2026)', icon: <ShieldCheck size={12}/> },
    { id: 'P07', name: 'Atomární audit', desc: 'Provázání Fakt -> Právo -> Důkaz', icon: <Layers size={12}/> },
    { id: 'P08', name: 'Red Team Report', desc: 'Zátěžový test integrity identity', icon: <ShieldCheck size={12}/> },
    { id: 'P09', name: 'Hierarchie 2+4', desc: 'Kontrola 2 hlavních a 4 sub argumentů', icon: <ListFilter size={12}/> },
    { id: 'P10', name: 'Nutriční Dieta', desc: 'Zeštíhlení a eliminace balastu', icon: <Scissors size={12}/> },
    { id: 'P11', name: 'Risk & Compliance', desc: 'Pravděpodobnost úspěchu a rizika', icon: <Gauge size={12}/> },
    { id: 'P12', name: 'Diferenční Analýza', desc: 'Integrace nových atomů z verzí', icon: <Diff size={12}/> },
    { id: 'P13', name: 'Administrativní Audit', desc: 'Kontrola procesních náležitostí', icon: <Scale size={12}/> },
    { id: 'P14', name: 'Audit Příloh', desc: 'Křížová kontrola existence příloh', icon: <Paperclip size={12}/> },
  ];

  const isIndexingRef = useRef(false);

  // Background Indexing Logic (Throttled & Locked)
  useEffect(() => {
    // Only start if not already indexing and not currently performing a main review
    if (isIndexingRef.current || isReviewing) return;

    const idleFile = uploadedFiles.find(f => f.indexStatus === 'IDLE' && f.content && !f.isArchived);
    
    if (idleFile) {
      const processFile = async () => {
        isIndexingRef.current = true;
        
        // Brief delay to allow UI to breathe and avoid rapid-fire API hits
        await new Promise(resolve => setTimeout(resolve, 2000));

        setUploadedFiles(prev => prev.map(f => f.id === idleFile.id ? { ...f, indexStatus: 'INDEXING' } : f));
        
        try {
          // Minimalist context for indexing to save tokens and avoid overhead
          const prompt = `Získej stručný vhled (2 věty) pro dokument: ${idleFile.name}. Zaměř se na právní podstatu.`;
          
          const result = await reviewCourtRequest(prompt, [`FILE: ${idleFile.name}\nCONTENT:\n${idleFile.content?.substring(0, 10000)}`], ['INDEXACE'], [], '', 'AUDIT');
          
          setUploadedFiles(prev => prev.map(f => f.id === idleFile.id ? { ...f, indexStatus: 'DONE', insight: result || '' } : f));
        } catch (e) {
          console.error('Indexing failed for:', idleFile.name, e);
          setUploadedFiles(prev => prev.map(f => f.id === idleFile.id ? { ...f, indexStatus: 'ERROR' } : f));
          // Wait longer on error before next attempt
          await new Promise(resolve => setTimeout(resolve, 5000));
        } finally {
          isIndexingRef.current = false;
        }
      };
      processFile();
    }
  }, [uploadedFiles, isReviewing]);

  const allFiles = [...uploadedFiles];

  const sortFilesOrdered = (files: FileEntry[]) => {
    const order = [
      "0 Framing",
      "1 Přehled",
      "2 PO",
      "3 Karta PO",
      "4 PR",
      "5 Karta PR",
      "6 Vyjádření k PR ZZ",
      "7 Vyjádření k soudnímu přípisu",
      "8 doplnění č1 do 909",
      "9 Karta 3",
      "10 Karta 4",
      "11 Přehled příloh",
      "index",
      "soubory zip",
      "rejstřík"
    ];

    return [...files].sort((a, b) => {
      const getPriority = (name: string) => {
        const lowerName = name.toLowerCase();
        for (let i = 0; i < order.length; i++) {
          if (lowerName.includes(order[i].toLowerCase())) return i;
          // Exact prefix check like "0", "1", "2" at start
          const prefix = order[i].split(' ')[0];
          if (lowerName.startsWith(prefix.toLowerCase() + ' ')) return i;
        }
        // Handle P1, P2 references at end
        const pMatch = lowerName.match(/^p(\d+)/);
        if (pMatch) return 1000 + parseInt(pMatch[1]);
        return 2000;
      };

      const prioA = getPriority(a.name);
      const prioB = getPriority(b.name);
      
      if (prioA !== prioB) return prioA - prioB;
      return a.name.localeCompare(b.name);
    });
  };

  const filteredFiles = (() => {
    const base = allFiles.filter(file => {
      const matchSearch = file.name.toLowerCase().includes(fileSearch.toLowerCase()) || 
                         file.type.toLowerCase().includes(fileSearch.toLowerCase());
      const matchArchive = showArchived ? file.isArchived : !file.isArchived;
      
      let matchVersion = true;
      if (versionFilter === 'CURRENT') {
        matchVersion = file.version === currentVersion && file.caseId === currentCaseId;
      } else if (versionFilter === 'ORPHAN') {
        matchVersion = !file.version || !file.caseId;
      } else if (versionFilter !== 'ALL') {
        matchVersion = file.version === versionFilter;
      }

      return matchSearch && matchArchive && matchVersion;
    });

    if (fileSortBy === 'ORDER') return sortFilesOrdered(base);

    return base.sort((a, b) => {
      if (fileSortBy === 'id') return a.id.localeCompare(b.id);
      if (fileSortBy === 'name') return a.name.localeCompare(b.name);
      if (fileSortBy === 'type') return a.type.localeCompare(b.type);
      if (fileSortBy === 'date') return b.timestamp - a.timestamp;
      if (fileSortBy === 'batch') return (a.batchId || '').localeCompare(b.batchId || '');
      return 0;
    });
  })();

  const archiveFile = (id: string) => {
    setUploadedFiles(prev => prev.map(f => f.id === id ? { ...f, isArchived: true } : f));
  };

  const restoreFile = (id: string) => {
    setUploadedFiles(prev => prev.map(f => f.id === id ? { ...f, isArchived: false } : f));
  };

  const deleteFile = (id: string) => {
    if (confirm('Opravdu chcete smazat tento soubor?')) {
      setUploadedFiles(prev => prev.filter(f => f.id !== id));
      setSelectedFileIds(prev => prev.filter(fId => fId !== id));
      setSupportFileIds(prev => prev.filter(fId => fId !== id));
      setStorageError(null); // Clear error on deletion attempt
    }
  };

  const speakText = (text?: string) => {
    if (!text) return;
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text.substring(0, 500)); // Sample start
    utterance.lang = 'cs-CZ';
    utterance.rate = 0.9;
    synth.speak(utterance);
  };

  const generatePDF = async () => {
    try {
      const { jsPDF } = await import('jspdf');
      const html2canvas = (await import('html2canvas')).default;
      
      const element = document.getElementById('audit-output-content') || document.getElementById('review-result-content');
      if (!element) {
        alert('Nebyl nalezen obsah pro generování PDF.');
        return;
      }

      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#0d0d0d',
        logging: false
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4', true);
      
      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;

      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
      pdf.save(`LG13_Report_${currentCaseId || 'CASE'}_${Date.now()}.pdf`);
    } catch (err) {
      console.error('PDF Generation failed:', err);
      alert('Generování PDF selhalo.');
    }
  };

  const clearAllData = () => {
    if (confirm('VAROVÁNÍ: Opravdu chcete smazat ABSOLUTNĚ VŠECHNA data?\nTato akce nevratně odstraní všechny spisy, soubory, indexy i historii úloh.')) {
      isResetting.current = true;
      localStorage.clear();
      if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
      
      // Secondary explicit clear for known keys
      const keys = ['juris_files', 'juris_queue', 'juris_strategy', 'juris_history', 'juris_cases', 'juris_current_case_id', 'juris_version', 'juris_git_context', 'is_drive_enabled', 'juris_drive_token'];
      keys.forEach(k => localStorage.removeItem(k));
      
      // Force reload to clean state
      window.location.href = window.location.origin + window.location.pathname;
    }
  };

  const toggleFileSelection = (id: string, type: 'SELECT' | 'SUPPORT' | 'BULK') => {
    if (type === 'BULK') {
      setSelectedBulkIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
      return;
    }
    if (type === 'SELECT') {
      setSelectedFileIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    } else {
      setSupportFileIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    }
  };

  const setBulkCategory = (category: FileEntry['category']) => {
    if (selectedBulkIds.length === 0) return;
    setUploadedFiles(prev => prev.map(f => selectedBulkIds.includes(f.id) ? { ...f, category } : f));
    setSelectedBulkIds([]);
  };

  const bulkAction = (action: 'DELETE' | 'ARCHIVE' | 'ASSIGN_CURRENT' | 'ADD_TO_AUDIT' | 'RENAME_VERSION') => {
    if (selectedBulkIds.length === 0) return;
    
    if (action === 'DELETE') {
      const count = selectedBulkIds.length;
      if (confirm(`Opravdu chcete smazat ${count} souborů?`)) {
        const idsToRemove = new Set(selectedBulkIds);
        setUploadedFiles(prev => prev.filter(f => !idsToRemove.has(f.id)));
        setSelectedFileIds(prev => prev.filter(id => !idsToRemove.has(id)));
        setSupportFileIds(prev => prev.filter(id => !idsToRemove.has(id)));
        setSelectedBulkIds([]);
        // Force clear error state to allow UI to breathe
        setStorageError(null);
      }
      return;
    } 
    
    if (action === 'ARCHIVE') {
      const idsToArchive = new Set(selectedBulkIds);
      setUploadedFiles(prev => prev.map(f => idsToArchive.has(f.id) ? { ...f, isArchived: true } : f));
      setSelectedBulkIds([]);
      return;
    } 
    
    if (action === 'ASSIGN_CURRENT') {
      const idsToAssign = new Set(selectedBulkIds);
      setUploadedFiles(prev => prev.map(f => idsToAssign.has(f.id) ? { ...f, caseId: currentCaseId, version: currentVersion } : f));
      setSelectedBulkIds([]);
      setTimeout(() => alert(`${idsToAssign.size} souborů bylo přiřazeno k aktuálnímu spisu a verzi (${currentVersion}).`), 100);
      return;
    }

    if (action === 'ADD_TO_AUDIT') {
      const idsToAdd = selectedBulkIds.filter(id => !selectedFileIds.includes(id));
      setSelectedFileIds(prev => [...prev, ...idsToAdd]);
      setSelectedBulkIds([]);
      return;
    }

    if (action === 'RENAME_VERSION') {
      const suggested = uploadedFiles.find(f => selectedBulkIds.includes(f.id))?.version || currentVersion;
      const newVer = prompt('Zadejte nový název verze pro vybrané soubory (Hromadně):', suggested);
      if (newVer) {
        const idsToUpdate = new Set(selectedBulkIds);
        setUploadedFiles(prev => prev.map(f => idsToUpdate.has(f.id) ? { ...f, version: newVer } : f));
        setSelectedBulkIds([]);
        setCurrentVersion(newVer);
      }
      return;
    }
  };

  const assignVersionToCase = (versionName: string) => {
    const targetCaseId = prompt('Zadejte cílové ID spisu (např. C01, C02...):', currentCaseId);
    if (targetCaseId && cases.some(c => c.id === targetCaseId)) {
      setUploadedFiles(prev => prev.map(f => f.version === versionName ? { ...f, caseId: targetCaseId } : f));
      setTimeout(() => alert(`VERZE ${versionName} BYLA PŘESUNUTA DO SPISU ${cases.find(c => c.id === targetCaseId)?.nr || targetCaseId}`), 100);
    } else if (targetCaseId) {
      alert('Chybné ID spisu.');
    }
  };

  const createNewVersionManually = () => {
    const name = prompt('Název nové verze (např. F16_REV):');
    if (name) {
      setCurrentVersion(name.toUpperCase());
      alert(`AKTIVNÍ VERZE NASTAVENA NA: ${name.toUpperCase()}`);
    }
  };

  const createNewCase = () => {
    setShowCaseModal(true);
    const defaultNr = `${new Date().getFullYear()}/LG/${cases.length + 10}`;
    setNewCaseData({ name: 'Nový případ ' + (cases.length + 1), nr: defaultNr });
  };

  const confirmCreateCase = () => {
    if (!newCaseData.name || !newCaseData.nr) return;

    const newId = `C-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const newCase = { 
      id: newId, 
      name: newCaseData.name.trim(), 
      nr: newCaseData.nr.trim(), 
      activeVersion: 'V1.0.0' 
    };
    
    setCases(prev => [...prev, newCase]);
    setCurrentCaseId(newId);
    setCurrentVersion('V1.0.0');
    
    // Reset selection context for the new case
    setSelectedFileIds([]);
    setSupportFileIds([]);
    setInputText('');
    setReviewResult(null);
    setShowCaseModal(false);
  };

  const getFileColor = (file: FileEntry) => {
    if (file.isArchived) return 'border-[#222] bg-[#0d0d0d] opacity-30 grayscale';
    
    switch(file.category) {
      case 'MAIN': return 'border-[#C5A059]/40 bg-[#C5A059]/5';
      case 'ATTACH': return 'border-blue-900/40 bg-blue-950/10';
      case 'SUPPORT': return 'border-emerald-900/40 bg-emerald-950/10';
      case 'SYSTEM': return 'border-purple-900/40 bg-purple-950/10';
      default: return 'border-[#333] bg-[#151515]';
    }
  };

  const addToQueue = () => {
    let selectedFiles: FileEntry[] = [];
    let versionLabel = currentVersion;

    if (selectionMode === 'VERSIONS') {
      if (compareVersionIds.length === 0) {
        alert('VYBERTE ALESPOŇ JEDNU VERZI PRO PŘIDÁNÍ DO FRONTY.');
        return;
      }
      selectedFiles = allFiles.filter(f => compareVersionIds.includes(f.version || ''));
      versionLabel = compareVersionIds.join(' + ');
    } else {
      if (selectedFileIds.length === 0) {
        alert('VYBERTE SOUBORY PRO PŘIDÁNÍ DO FRONTY.');
        return;
      }
      selectedFiles = allFiles.filter(f => selectedFileIds.includes(f.id));
    }
    
    const supportFiles = allFiles.filter(f => supportFileIds.includes(f.id));
    const selectedPillars = auditPillars.filter(p => selectedPillarIds.includes(p.id));
    
    if (selectedPillars.length === 0) {
      alert('VYBERTE ALESPOŇ JEDNU ANALÝZU (PILÍŘ).');
      return;
    }

    const newTasks: AuditTask[] = [];

    if (selectionMode === 'VERSIONS' && compareVersionIds.length === 2) {
      const v1 = compareVersionIds[0];
      const v2 = compareVersionIds[1];
      const filesV1 = allFiles.filter(f => f.version === v1);
      const filesV2 = allFiles.filter(f => f.version === v2);

      // Find common files by name
      const commonNames = filesV1.filter(f1 => filesV2.some(f2 => f2.name === f1.name)).map(f => f.name);

      if (commonNames.length > 0) {
        commonNames.forEach(name => {
          newTasks.push({
            id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
            files: [name],
            supportFiles: supportFiles.map(f => f.name),
            pillars: selectedPillars.map(p => p.name),
            status: 'pending',
            timestamp: Date.now(),
            version: `${v1} ➔ ${v2} (${name})`
          });
        });
        
        // Also add a summary task
        newTasks.push({
            id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
            files: commonNames,
            supportFiles: supportFiles.map(f => f.name),
            pillars: ['Diferenční Analýza'],
            status: 'pending',
            timestamp: Date.now(),
            version: `${v1} ➔ ${v2} (CELKOVÝ SUMÁŘ)`
        });
      } else {
        // Fallback to combined if no common names found
        newTasks.push({
          id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
          files: selectedFiles.map(f => f.name),
          supportFiles: supportFiles.map(f => f.name),
          pillars: selectedPillars.map(p => p.name),
          status: 'pending',
          timestamp: Date.now(),
          version: versionLabel
        });
      }
    } else if (queueStrategy === 'COMBINE') {
      newTasks.push({
        id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
        files: selectedFiles.map(f => f.name),
        supportFiles: supportFiles.map(f => f.name),
        pillars: selectedPillars.map(p => p.name),
        status: 'pending',
        timestamp: Date.now(),
        version: versionLabel
      });
    } else if (queueStrategy === 'PER_FILE') {
      selectedFiles.forEach(mainFile => {
        const otherSelected = selectedFiles.filter(f => f.id !== mainFile.id).map(f => f.name);
        newTasks.push({
          id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
          files: [mainFile.name],
          supportFiles: [...otherSelected, ...supportFiles.map(f => f.name)],
          pillars: selectedPillars.map(p => p.name),
          status: 'pending',
          timestamp: Date.now(),
          version: mainFile.version || versionLabel
        });
      });
    } else if (queueStrategy === 'CROSS') {
      selectedFiles.forEach(mainFile => {
        const otherSelected = selectedFiles.filter(f => f.id !== mainFile.id).map(f => f.name);
        selectedPillars.forEach(pillar => {
          newTasks.push({
            id: `Q-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
            files: [mainFile.name],
            supportFiles: [...otherSelected, ...supportFiles.map(f => f.name)],
            pillars: [pillar.name],
            status: 'pending',
            timestamp: Date.now(),
            version: mainFile.version || versionLabel
          });
        });
      });
    }

    setAuditQueue(prev => [...newTasks, ...prev]);
  };

  const toggleAllPillars = (select: boolean) => {
    if (select) {
      setSelectedPillarIds(auditPillars.map(p => p.id));
    } else {
      setSelectedPillarIds([]);
    }
  };

  const ensureFileContent = async (file: FileEntry): Promise<string> => {
    if (file.content) return file.content;
    if (file.driveId && driveToken) {
      try {
        const drive = new GoogleDriveService(driveToken);
        const content = await drive.getFileContent(file.driveId);
        // Temporarily put back in state for current operation, but don't force save to local storage immediately
        setUploadedFiles(prev => prev.map(f => f.id === file.id ? { ...f, content } : f));
        return content;
      } catch (err) {
        console.error('Failed to fetch from Drive:', err);
        return '[Chyba: Nepodařilo se stáhnout z Google Drive. Přihlaste se znovu.]';
      }
    }
    return '[Obsah chybí]';
  };

  const handleReview = async (taskId?: string) => {
    const isMainInputPresent = inputText.trim().length > 0;
    const isSelectionPresent = selectionMode === 'FILES' ? selectedFileIds.length > 0 : compareVersionIds.length > 0;
    
    if (!isMainInputPresent && !isSelectionPresent && !taskId) {
      alert('CHYBÍ VSTUPNÍ DATA PRO ANALÝZU.');
      return;
    }

    setIsReviewing(true);
    setError(null);
    if (!taskId) setReviewResult(null);

    let targetFiles: string[] = [];
    let supportFiles: string[] = [];
    let targetPillars: string[] = [];
    let selectedFilesObjects: FileEntry[] = [];
    let processingTaskId = taskId;
    if (processingTaskId) setCurrentProcessingId(processingTaskId);

    const allFiles = [...uploadedFiles];

    if (taskId) {
      const task = auditQueue.find(t => t.id === taskId);
      if (task) {
        // Find files by name and version to ensure correct content
        selectedFilesObjects = allFiles.filter(f => 
          task.files.includes(f.name) && 
          (!task.version || task.version.includes(f.version || ''))
        );
        const resolvedFiles = await Promise.all(selectedFilesObjects.map(async f => ({ ...f, content: await ensureFileContent(f) })));
        targetFiles = resolvedFiles.map(f => `FILE: ${f.name}\nCONTENT:\n${f.content || '[Obsah nelze extrahovat nebo je prázdný]'}`);
        
        const supportFilesObjects = allFiles.filter(f => 
          task.supportFiles.includes(f.name) &&
          (!task.version || task.version.includes(f.version || ''))
        );
        const resolvedSupport = await Promise.all(supportFilesObjects.map(async f => ({ ...f, content: await ensureFileContent(f) })));
        supportFiles = resolvedSupport.map(f => `FILE: ${f.name}\nCONTENT:\n${f.content || '[Obsah nelze extrahovat]'}`);
        
        targetPillars = task.pillars;
        setAuditQueue(prev => prev.map(t => t.id === taskId ? { ...t, status: 'processing' } : t));
      }
    } else {
      selectedFilesObjects = allFiles.filter(f => {
        if (selectionMode === 'VERSIONS') {
          return compareVersionIds.includes(f.version || '');
        }
        return selectedFileIds.includes(f.id);
      });
      const resolvedFiles = await Promise.all(selectedFilesObjects.map(async f => ({ ...f, content: await ensureFileContent(f) })));
      targetFiles = resolvedFiles.map(f => `FILE: ${f.name}\nCONTENT:\n${f.content || '[Obsah prázdný]'}`);
      
      const supportFilesObjects = allFiles.filter(f => supportFileIds.includes(f.id));
      const resolvedSupport = await Promise.all(supportFilesObjects.map(async f => ({ ...f, content: await ensureFileContent(f) })));
      supportFiles = resolvedSupport.map(f => `FILE: ${f.name}\nCONTENT:\n${f.content || '[Obsah prázdný]'}`);
      
      targetPillars = auditPillars.filter(p => selectedPillarIds.includes(p.id)).map(p => p.name);
    }

    try {
      const apiKey = process.env.GEMINI_API_KEY || (process.env as any).API_KEY;
      if (!apiKey) {
        throw new Error('CHYBA: Gemini API klíč nebyl nalezen. Prosím proveďte následující:\n1. Jděte do Settings (ozubené kolečko vlevo dole)\n2. Secrets\n3. Přidejte GEMINI_API_KEY.');
      }

      const mode = (selectionMode === 'VERSIONS' && compareVersionIds.length === 2 && !taskId) ? 'VERSION_DIFF' : appMode;
      const otherInsights = allFiles
        .filter(f => f.version === (selectedFilesObjects.length > 0 ? selectedFilesObjects[0].version : currentVersion) && f.insight)
        .map(f => `SOUBOR: ${f.name} - VHLED: ${f.insight}`)
        .join('\n');

      const combinedInstructions = `${notes}\n\nRELAČNÍ_KONTEXT_PODÁNÍ (Indexované vhledy):\n${otherInsights}\n\nEXTERNAL_CONTEXT:\n${gitContext}`;
      const result = await reviewCourtRequest(inputText, targetFiles, targetPillars, supportFiles, combinedInstructions, mode as any, compareVersionIds);
      if (processingTaskId) {
        setAuditQueue(prev => prev.map(t => t.id === processingTaskId ? { ...t, status: 'done', result: result || undefined, isNotified: true } : t));
        setActiveQueueId(processingTaskId);
        setTimeout(() => setAuditQueue(prev => prev.map(t => t.id === processingTaskId ? { ...t, isNotified: false } : t)), 5000);
      } else {
        setReviewResult(result || null);
      }
      
      // Auto-focus the output section
      setTimeout(() => {
        const outputElement = document.getElementById('audit-output');
        if (outputElement) outputElement.scrollIntoView({ behavior: 'smooth' });
      }, 300);

    } catch (err: any) {
      console.error('Audit Engine Error:', err);
      setError(err.message || 'Error occurred');
      if (processingTaskId) {
        setAuditQueue(prev => prev.map(t => t.id === processingTaskId ? { ...t, status: 'error', error: err.message || 'Unknown error' } : t));
      }
    } finally {
      setIsReviewing(false);
      setCurrentProcessingId(null);
    }
  };

  const executeAllQueue = async () => {
    const pendingTasks = [...auditQueue].filter(t => t.status === 'pending' || t.status === 'error');
    if (pendingTasks.length === 0) return;
    
    setIsQueueRunning(true);
    stopRequestedRef.current = false;
    for (const task of pendingTasks) {
      if (stopRequestedRef.current) break;
      await handleReview(task.id);
      // Small delay between tasks to avoid overwhelming the proxy
      await new Promise(r => setTimeout(r, 1000));
    }
    setIsQueueRunning(false);
    stopRequestedRef.current = false;
  };

  const stopQueue = () => {
    stopRequestedRef.current = true;
    setIsQueueRunning(false);
  };

  const clearQueue = () => {
    if (confirm('Opravdu chcete vymazat celou frontu úloh?')) {
      setAuditQueue([]);
      setActiveQueueId(null);
    }
  };

  const fetchDriveFolderFiles = async () => {
    if (!driveToken) return;
    setIsDrivePickerLoading(true);
    setIsDrivePickerOpen(true);
    try {
      const drive = new GoogleDriveService(driveToken);
      const files = await drive.listFiles();
      setDriveFolderFiles(files);
    } catch (err) {
      console.error('Failed to fetch drive files:', err);
      alert('Nepodařilo se načíst seznam souborů z Google Drive.');
    } finally {
      setIsDrivePickerLoading(false);
    }
  };

  const importDriveFile = async (df: GDriveFile) => {
    if (!driveToken) return;
    try {
      const drive = new GoogleDriveService(driveToken);
      const content = await drive.getFileContent(df.id);
      const appProps = (df as any).appProperties || {};
      
      const newFile: FileEntry = {
        id: `D-${df.id.substring(0, 6)}-${Date.now()}`,
        driveId: df.id,
        name: df.name,
        type: df.name.split('.').pop()?.toUpperCase() || 'DRIVE',
        category: appProps.category || 'ATTACH',
        isUploaded: true,
        timestamp: parseInt(appProps.timestamp) || Date.now(),
        version: appProps.version || currentVersion,
        caseId: appProps.caseId || currentCaseId,
        content: content,
        indexStatus: 'IDLE'
      };
      
      setUploadedFiles(prev => [newFile, ...prev]);
      return true;
    } catch (err) {
      console.error('Failed to import drive file:', err);
      alert(`Nepodařilo se importovat soubor ${df.name}`);
      return false;
    }
  };

  const syncDriveFiles = async () => {
    if (!driveToken) return;
    setIsSyncingDrive(true);
    try {
      const drive = new GoogleDriveService(driveToken);
      const files = await drive.listFiles();
      const newEntries: FileEntry[] = [];
      
      for (const df of files) {
        // Check if already in state by driveId
        if (uploadedFiles.some(f => f.driveId === df.id)) continue;
        
        const content = await drive.getFileContent(df.id);
        const appProps = (df as any).appProperties || {};
        
        newEntries.push({
          id: `D-${df.id.substring(0, 6)}`,
          driveId: df.id,
          name: df.name,
          type: df.name.split('.').pop()?.toUpperCase() || 'DRIVE',
          category: appProps.category || 'ATTACH',
          isUploaded: true,
          timestamp: parseInt(appProps.timestamp) || Date.now(),
          version: appProps.version || 'DRIVE',
          caseId: appProps.caseId || currentCaseId,
          content: content,
          indexStatus: 'IDLE'
        });
      }
      
      if (newEntries.length > 0) {
        setUploadedFiles(prev => [...prev, ...newEntries]);
        alert(`Synchronizováno ${newEntries.length} nových souborů z Google Drive.`);
      } else {
        alert('Žádné nové soubory na Google Drive nenalezeny.');
      }
    } catch (err) {
      console.error('Drive sync failed:', err);
      if (err instanceof Error && (err.message.includes('401') || err.message.includes('expired'))) {
        setDriveToken(null);
        localStorage.removeItem('juris_drive_token');
        alert('Relace Google Drive vypršela. Přihlaste se prosím znovu.');
      }
    } finally {
      setIsSyncingDrive(false);
    }
  };

  const [lastSyncTime, setSyncTime] = useState<number | null>(null);

  const reconcileDrive = async () => {
    if (!driveToken) return;
    setIsReconciling(true);
    try {
      const drive = new GoogleDriveService(driveToken);
      
      // 1. Get remote state
      const remoteFiles = await drive.listFiles();
      
      // 2. Upload local files that are NOT on Drive
      const unsyncedLocals = uploadedFiles.filter(f => !f.driveId && f.content);
      for (const f of unsyncedLocals) {
        try {
          const metadata = {
            category: f.category,
            version: f.version || '',
            caseId: f.caseId || '',
            timestamp: f.timestamp.toString()
          };
          const gFile = await drive.uploadFile(f.name, f.content!, metadata);
          setUploadedFiles(prev => prev.map(uf => uf.id === f.id ? { ...uf, driveId: gFile.id } : uf));
        } catch (err) {
          console.error(`Failed to upload ${f.name} during reconcile:`, err);
        }
      }

      // 3. Download files from Drive that are NOT locally
      const newEntries: FileEntry[] = [];
      for (const df of remoteFiles) {
        if (uploadedFiles.some(f => f.driveId === df.id || f.name === df.name)) continue;
        
        try {
          const content = await drive.getFileContent(df.id);
          const appProps = (df as any).appProperties || {};
          
          newEntries.push({
            id: `D-${df.id.substring(0, 6)}`,
            driveId: df.id,
            name: df.name,
            type: df.name.split('.').pop()?.toUpperCase() || 'DRIVE',
            category: appProps.category || 'ATTACH',
            isUploaded: true,
            timestamp: parseInt(appProps.timestamp) || Date.now(),
            version: appProps.version || 'DRIVE',
            caseId: appProps.caseId || currentCaseId,
            content: content,
            indexStatus: 'IDLE'
          });
        } catch (err) {
          console.error(`Failed to download ${df.name} during reconcile:`, err);
        }
      }

      if (newEntries.length > 0) {
        setUploadedFiles(prev => [...prev, ...newEntries]);
      }
      
      // Refresh quota
      const about = await drive.getAbout();
      if (about.storageQuota) {
        setDriveQuota({
          limit: parseInt(about.storageQuota.limit),
          usage: parseInt(about.storageQuota.usage)
        });
      }

      setSyncTime(Date.now());
      alert('Synchronizace s Google Drive dokončena.');
    } catch (err) {
      console.error('Reconcile failed:', err);
      alert('Synchronizace selhala. Zkuste to prosím později.');
    } finally {
      setIsReconciling(false);
    }
  };

  const syncGitHubFiles = async () => {
    if (!gitHubRepo) {
      alert('Zadejte GitHub repozitář ve formátu "owner/repo"');
      return;
    }
    
    setIsSyncingGitHub(true);
    try {
      const [owner, repo] = gitHubRepo.split('/');
      const github = new GitHubService(owner, repo, gitHubToken);
      const files = await github.getTerminalFiles();
      
      const newEntries: FileEntry[] = [];
      const updatedFiles = [...uploadedFiles];
      let updatedCount = 0;
      let newCount = 0;

      for (const gf of files) {
        if (gf.type !== 'file') continue;
        
        // Skip hidden files or specific non-legal files if needed
        if (gf.name.startsWith('.')) continue;

        const content = await github.getFileContent(gf.path);
        
        const existingIdx = updatedFiles.findIndex(f => f.githubPath === gf.path || (f.name === gf.name && !f.driveId));
        
        if (existingIdx >= 0) {
          updatedFiles[existingIdx] = {
            ...updatedFiles[existingIdx],
            content: content,
            githubPath: gf.path,
            timestamp: Date.now() // Mark as updated
          };
          updatedCount++;
        } else {
          newEntries.push({
            id: `GH-${gf.sha.substring(0, 6)}-${Date.now()}`,
            githubPath: gf.path,
            name: gf.name,
            type: gf.name.split('.').pop()?.toUpperCase() || 'GH',
            category: 'ATTACH',
            isUploaded: true,
            timestamp: Date.now(),
            version: 'GITHUB',
            caseId: currentCaseId,
            content: content,
            indexStatus: 'IDLE'
          });
          newCount++;
        }
      }
      
      setUploadedFiles([...updatedFiles, ...newEntries]);
      alert(`GitHub Sync: Načteno ${newCount} nových a aktualizováno ${updatedCount} existujících souborů.`);
    } catch (err: any) {
      console.error('GitHub sync failed:', err);
      let msg = `GitHub synchronizace selhala: ${err.message}`;
      if (err.message?.includes('Not Found')) {
        msg += '\n\nTIP: Zkontrolujte, zda repozitář existuje a zda má váš Token (PAT) správná oprávnění (repo).';
      }
      alert(msg);
    } finally {
      setIsSyncingGitHub(false);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    const batchId = uploadBatchId || `B-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const firstFileName = files[0].name.split('.')[0].toUpperCase();
    
    // Auto-Versioning: If this is a fresh batch, suggest a new version name based on the file
    if (!uploadBatchId) {
      const suggestedVersion = files.length === 1 ? firstFileName : batchId;
      setCurrentVersion(suggestedVersion);
    }

    const newFiles: FileEntry[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      // Use the batch ID or the specific file suggested version
      const fileVersion = files.length === 1 ? firstFileName : (uploadBatchId ? currentVersion : firstFileName);
      const newFileId = `U-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

      if (ext === 'json') {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const content = JSON.parse(e.target?.result as string);
            if (content.atoms) {
              if (confirm('Nalezeny datové atomy. Chcete je integrovat do aktuálního návrhu?')) {
                setInputText(prev => prev + '\n\n// INTEGROVANÉ ATOMY:\n' + JSON.stringify(content.atoms, null, 2));
              }
            }
          } catch (err) { console.error('JSON parse error', err); }
        };
        reader.readAsText(file);
      }

      if (ext === 'zip') {
        const zip = new JSZip();
        try {
          const content = await zip.loadAsync(file);
          const zipVersion = file.name.replace('.zip', '').toUpperCase();
          setCurrentVersion(zipVersion); // Auto-focus this zip as its own version

          for (const [path, entry] of Object.entries(content.files)) {
            if (!entry.dir) {
              const fileId = `U-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
              const fileContent = await entry.async('string');
              
              newFiles.push({ 
                id: fileId, 
                name: entry.name, type: entry.name.split('.').pop()?.toUpperCase() || 'ZIP_ITEM', 
                isUploaded: true, timestamp: Date.now(), batchId,
                category: 'ATTACH', version: zipVersion, caseId: currentCaseId,
                content: fileContent,
                indexStatus: 'IDLE'
              });
            }
          }
        } catch (err) {
          console.error("Failed to load ZIP", err);
        }
      } else {
        const fileReader = new FileReader();
        fileReader.onload = async (e) => {
          const content = e.target?.result as string;
          
          if (isDriveEnabled && driveToken) {
            try {
              const drive = new GoogleDriveService(driveToken);
              const metadata = {
                category: 'ATTACH',
                version: currentVersion,
                caseId: currentCaseId,
                timestamp: Date.now().toString()
              };
              const gFile = await drive.uploadFile(file.name, content, metadata);
              setUploadedFiles(prev => prev.map(f => f.id === newFileId ? { ...f, content, driveId: gFile.id } : f));
            } catch (err) {
              console.error('Drive upload failed:', err);
            }
          } else {
            setUploadedFiles(prev => prev.map(f => f.id === newFileId ? { ...f, content } : f));
          }
        };
        fileReader.readAsText(file);
        
        newFiles.push({ 
          id: newFileId, 
          name: file.name, type: ext?.toUpperCase() || 'FILE', isUploaded: true, timestamp: Date.now(), batchId,
          category: 'ATTACH', version: currentVersion, caseId: currentCaseId,
          indexStatus: 'IDLE'
        });
      }
    }
    setUploadedFiles(prev => [...prev, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const createNewVersion = () => {
    const vMatch = currentVersion.match(/V(\d+)\.?(\d+)?/);
    let nextVersion = 'V2.0';
    if (vMatch) {
      const main = parseInt(vMatch[1]);
      nextVersion = `V${main + 1}.0`;
    }
    
    const snapshot: VersionRecord = {
      id: Math.random().toString(36).substr(2, 6).toUpperCase(),
      version: currentVersion,
      text: inputText,
      timestamp: Date.now(),
      selectedFiles: [...selectedFileIds],
      selectedPillars: [...selectedPillarIds]
    };

    setHistory(prev => [snapshot, ...prev]);
    setCurrentVersion(nextVersion);
  };

  const restoreVersion = (v: VersionRecord) => {
    setInputText(v.text);
    setCurrentVersion(v.version);
    setSelectedFileIds(v.selectedFiles);
    setSelectedPillarIds(v.selectedPillars);
    setShowHistory(false);
  };

  const togglePillarSelection = (id: string) => {
    setSelectedPillarIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const removeFromQueue = (id: string) => {
    setAuditQueue(prev => prev.filter(t => t.id !== id));
  };

  const handleCopy = () => {
    if (reviewResult) {
      navigator.clipboard.writeText(reviewResult);
      alert('Kopírováno do schránky');
    }
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(h => h.id !== id));
    setCompareVersionIds(prev => prev.filter(vId => vId !== id));
  };

  const toggleCompare = (id: string) => {
    setCompareVersionIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id].slice(-2)
    );
  };

  const parseJsonFromResult = (result?: string) => {
    if (!result) return null;
    const match = result.match(/```json\s?([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        // Fallback for non-standard JSON blocks
        try {
           const simpleMatch = result.match(/\{[\s\S]*\}/);
           if (simpleMatch) return JSON.parse(simpleMatch[0]);
        } catch { return null; }
      }
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-[#CCC] selection:bg-[#C5A059] selection:text-black font-sans">
      <AnimatePresence>
        {storageError && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-8 bg-black/80 backdrop-blur-md"
          >
            <div className="w-full max-w-xl bg-[#151515] border border-red-500 p-8 shadow-2xl">
              <div className="flex items-start gap-4 mb-8">
                <Database size={32} className="text-red-500 shrink-0" />
                <div>
                  <h3 className="text-sm font-black uppercase text-red-500 mb-2">SYSTÉMOVÉ VAROVÁNÍ // KRITICKÝ NEDOSTATEK PAMĚTI</h3>
                  <p className="text-[11px] text-red-200 leading-relaxed font-medium">
                    Prohlížeč zamezil uložení dat, protože bylo dosaženo technického limitu (QuotaExceeded). 
                    Vaše data jsou v bezpečí v operační paměti, ale nebudou moci být uložena do příštího spuštění, dokud neuvolníte místo.
                  </p>
                </div>
              </div>

              <div className="grid gap-4">
                {selectedBulkIds.length > 0 && (
                  <button 
                    onClick={() => {
                      const count = selectedBulkIds.length;
                      if (confirm(`Smazat ${count} označených souborů pro uvolnění místa?`)) {
                        const idsToRemove = new Set(selectedBulkIds);
                        setUploadedFiles(prev => prev.filter(f => !idsToRemove.has(f.id)));
                        setSelectedFileIds(prev => prev.filter(id => !idsToRemove.has(id)));
                        setSupportFileIds(prev => prev.filter(id => !idsToRemove.has(id)));
                        setSelectedBulkIds([]);
                        setStorageError(null);
                      }
                    }} 
                    className="w-full py-3 text-[10px] font-black uppercase text-center bg-red-950 text-red-500 border border-red-500 hover:bg-red-500 hover:text-white transition-all"
                  >
                    Smazat označené soubory ({selectedBulkIds.length})
                  </button>
                )}
                <button 
                  onClick={() => {
                    const withDrive = uploadedFiles.filter(f => f.driveId);
                    if (withDrive.length > 0) {
                      setUploadedFiles(prev => prev.map(f => f.driveId ? { ...f, content: undefined } : f));
                      setStorageError(null);
                      alert(`Uvolněno ${withDrive.length} souborů z lokální paměti (jsou bezpečně na Drive).`);
                    } else if (isDriveEnabled) {
                      alert('Momentálně nemáte žádné soubory synchronizované s Google Drive. Synchronizace selže, pokud je paměť plná. Doporučujeme smazat velké soubory ručně nebo provést Hard Reset.');
                    } else {
                      alert('Pro uvolnění místa bez ztráty dat připojte Google Drive.');
                      login();
                    }
                  }} 
                  className={cn(
                    "w-full py-3 text-[10px] font-black uppercase text-center border transition-all",
                    isDriveEnabled ? "bg-[#C5A059] text-black border-[#C5A059] hover:bg-white" : "border-[#333] text-[#666] hover:border-white"
                  )}
                >
                  {isDriveEnabled ? 'Uvolnit lokálně (Ponechat na Drive)' : 'Krok 1: Připojit Drive (Záchrana dat)'}
                </button>

                <div className="grid grid-cols-2 gap-4">
                  <button 
                    onClick={() => {
                      setStorageError(null);
                    }} 
                    className="py-3 text-[10px] font-black uppercase text-center border border-[#222] text-[#444] hover:text-white"
                  >
                    Rozumím (Pokračovat bez uložení)
                  </button>
                  <button 
                    onClick={clearAllData} 
                    className="py-3 text-[10px] font-black uppercase text-center bg-red-600 text-white hover:bg-red-500 transition-all shadow-[0_0_20px_rgba(220,38,38,0.3)]"
                  >
                    Hard Reset (Smazat VŠE)
                  </button>
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-[#222] flex justify-between items-center text-[8px] font-mono text-[#444]">
                <span>MOD_BUFFER: QUOTA_PROTECT_ENABLED</span>
                <span>UUID: {user?.uid?.substring(0,8) || 'GUEST'}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <header className="mx-auto max-w-7xl px-6 py-12 flex flex-col md:flex-row justify-between items-start md:items-center gap-8 border-b border-[#222]">
        <div className="relative">
          <div className="text-[11px] uppercase tracking-[0.3em] text-[#888] mb-6 flex items-center gap-2">
            <Scale size={14} className="text-[#C5A059]" />
            Profesionální Portál pro Audit Dokumentů
          </div>
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter leading-none select-none">
            §LG<span className="text-[#EAEAEA]">13</span>§<br/>
            <span className="text-transparent text-stroke opacity-30">TERMINÁL</span>
          </h1>
        </div>
          <div className="flex flex-col items-start md:items-end w-full md:w-auto">
            <div className="flex gap-4 items-center mb-4">
              {user ? (
                <div className="flex items-center gap-4 bg-[#111] border border-[#222] px-3 py-1.5 transition-all hover:border-[#C5A059]/50">
                  <div className="flex flex-col items-end">
                    <button 
                      onClick={reconcileDrive}
                      disabled={isReconciling}
                      className="flex items-center gap-2 group mb-0.5"
                      title={driveQuota ? `Google Drive: ${(driveQuota.usage / (1024*1024*1024)).toFixed(2)} GB / ${(driveQuota.limit / (1024*1024*1024)).toFixed(0)} GB` : 'Synchronizovat s Drive'}
                    >
                      <span className={cn(
                        "text-[9px] font-black uppercase transition-colors",
                        isReconciling ? "text-blue-400" : "text-[#C5A059] group-hover:text-white"
                      )}>
                        Cloud Sync {isDriveEnabled ? (isReconciling ? 'Slaďuji...' : '// Drive ON') : '// LOCAL ONLY'}
                      </span>
                      {isDriveEnabled && driveQuota && (
                        <div className="flex items-center gap-2">
                          <div className="w-12 h-1 bg-[#222] rounded-full overflow-hidden hidden sm:block">
                            <div 
                              className="h-full bg-[#C5A059] transition-all duration-1000" 
                              style={{ width: `${Math.min(100, (driveQuota.usage / driveQuota.limit) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[7px] font-mono text-[#666] hidden sm:block">
                            {Math.round((driveQuota.usage / driveQuota.limit) * 100)}%
                          </span>
                        </div>
                      )}
                      <div className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        isReconciling ? "bg-blue-500 animate-pulse" : "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                      )} />
                    </button>
                    <span className="text-[8px] text-[#666]">{user.email}</span>
                  </div>
                  <button onClick={logout} className="p-1.5 text-[#444] hover:text-red-500 transition-colors" title="Odhlásit se">
                    <LogOut size={14} />
                  </button>
                  {(isCloudSyncing || isSyncingDrive) && <RefreshCcw size={10} className="animate-spin text-[#C5A059]" />}
                </div>
              ) : (
                <button onClick={login} className="px-4 py-2 text-[10px] uppercase font-black bg-[#C5A059] text-black border border-[#C5A059] hover:bg-white transition-all flex items-center gap-2">
                  <LogIn size={12}/> Přihlásit se pro Cloud Sync
                </button>
              )}
            </div>
            <div className="flex gap-4">
              <button onClick={() => setShowHelp(true)} className="px-4 py-2 text-[10px] uppercase font-black border border-[#C5A059] text-[#C5A059] hover:bg-[#C5A059] hover:text-black transition-all flex items-center gap-2">
                <ShieldCheck size={12}/> README / HELP
              </button>
              <div className="flex items-center gap-2">
                <select 
                  value={currentCaseId} 
                  onChange={(e) => setCurrentCaseId(e.target.value)}
                  className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-black text-[#C5A059] outline-none cursor-pointer"
                >
                  {cases.map(c => <option key={c.id} value={c.id}>{c.nr} // {c.name}</option>)}
                </select>
                <button onClick={createNewCase} title="Vytvořit Nový Spis (Všechny parametry)" className="p-1.5 bg-[#C5A059] border border-[#C5A059] text-black hover:bg-white transition-all"><Plus size={14}/></button>
              </div>
              <button onClick={() => setShowHistory(!showHistory)} className={cn("px-4 py-2 text-[10px] uppercase font-black border transition-all flex items-center gap-2 relative", showHistory || compareVersionIds.length > 0 ? "bg-[#C5A059] text-black border-[#C5A059]" : "border-[#222] text-[#666] hover:border-[#444]")}>
                <History size={12}/> Historie {compareVersionIds.length > 0 && <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[8px] px-1 rounded-full">{compareVersionIds.length}</span>}
              </button>
              <div className="flex items-center gap-1 bg-[#111] border border-[#222] px-2" title="Aktuální verze / Kliknutím přejmenujete Snapshot">
                <span className="text-[8px] text-[#C5A059] uppercase font-black mr-2">Version</span>
                <input 
                  type="text" 
                  value={currentVersion} 
                  onChange={(e) => setCurrentVersion(e.target.value)} 
                  className="bg-transparent border-none text-[10px] font-black text-white w-16 outline-none text-center hover:bg-white/5 transition-colors"
                />
                <button onClick={createNewVersion} title="Vytvořit Snapshot (Záloha aktuálního stavu)" className="text-[#444] hover:text-[#C5A059] ml-2"><Layers size={10}/></button>
              </div>
            </div>
          <div className="text-[10px] font-mono text-[#444] uppercase tracking-widest px-2 py-1 mt-2 border border-[#222] flex items-center gap-2">
            STAV: AKTIVNÍ DOKUMENTACE <span className="text-[#C5A059]">SYNC: OK</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-20">
        <AnimatePresence>
          {showHistory && (
            <motion.section initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mb-12 overflow-hidden border-b border-[#222] pb-12">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#C5A059] font-black">ARCHIV_VERZÍ_DOKUMENTU</h2>
                <div className="text-[9px] font-mono text-[#444] uppercase">Vyberte 2 pro porovnání</div>
              </div>
              <div className="grid gap-2">
                {history.map(item => (
                  <div key={item.id} className={cn("flex items-center justify-between p-4 border transition-all", compareVersionIds.includes(item.id) ? "border-[#C5A059] bg-[#C5A059]/10" : "border-[#222] bg-[#151515]")}>
                    <div className="flex items-center gap-6">
                      <div className="text-[10px] font-black text-[#888] w-12">{item.version}</div>
                      <div className="text-[9px] font-mono text-[#666]">{new Date(item.timestamp).toLocaleString()}</div>
                      <div className="text-[9px] text-[#555] max-w-xs truncate italic">{item.text.substring(0, 50)}...</div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => toggleCompare(item.id)} className={cn("px-3 py-1 text-[9px] uppercase font-black border transition-all", compareVersionIds.includes(item.id) ? "bg-[#C5A059] text-black border-[#C5A059]" : "border-[#222] text-[#666] hover:border-white")}>Porovnat</button>
                      <button onClick={() => restoreVersion(item)} className="px-3 py-1 text-[9px] uppercase font-black border border-[#222] text-[#666] hover:border-emerald-500 hover:text-emerald-500 transition-all">Obnovit</button>
                      <button onClick={() => deleteHistoryItem(item.id)} className="p-1.5 text-red-950 hover:text-red-500 transition-all"><Trash2 size={14}/></button>
                    </div>
                  </div>
                ))}
                {history.length === 0 && <div className="text-center py-8 text-[10px] text-[#222] uppercase tracking-widest border border-dashed border-[#111]">Žádná historie záznamů</div>}
              </div>
              
              {compareVersionIds.length === 2 && (
                <div className="mt-8 border border-[#222] p-8 bg-[#050505]">
                  <div className="flex justify-between mb-4 border-b border-[#111] pb-2">
                    <h3 className="text-[10px] font-black uppercase tracking-widest text-[#C5A059]">Diferenční Analýza</h3>
                    <button onClick={() => setCompareVersionIds([])} className="text-[#444] hover:text-white"><X size={14}/></button>
                  </div>
                  <div className="grid grid-cols-2 gap-8 h-64 overflow-y-auto custom-scrollbar pr-4 italic font-serif text-[#777]">
                    <div>
                      <div className="text-[8px] uppercase text-[#333] mb-2">Původní ({history.find(h => h.id === compareVersionIds[0])?.version})</div>
                      <p className="text-xs">{history.find(h => h.id === compareVersionIds[0])?.text}</p>
                    </div>
                    <div>
                      <div className="text-[8px] uppercase text-[#333] mb-2">Cílová ({history.find(h => h.id === compareVersionIds[1])?.version})</div>
                      <p className="text-xs">{history.find(h => h.id === compareVersionIds[1])?.text}</p>
                    </div>
                  </div>
                </div>
              )}
            </motion.section>
          )}
        </AnimatePresence>
        <section className="mb-12 mt-12">
          <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-6">
            <div>
              <div className="flex gap-4 mb-4">
                <button 
                  onClick={() => toggleSelectionMode('FILES')}
                  className={cn("text-[10px] font-black uppercase tracking-widest pb-1 transition-all", selectionMode === 'FILES' ? "text-[#C5A059] border-b-2 border-[#C5A059]" : "text-[#444] hover:text-[#666]")}
                >
                  Individuální Soubory
                </button>
                <button 
                  onClick={() => toggleSelectionMode('VERSIONS')}
                  className={cn("text-[10px] font-black uppercase tracking-widest pb-1 transition-all", selectionMode === 'VERSIONS' ? "text-[#C5A059] border-b-2 border-[#C5A059]" : "text-[#444] hover:text-[#666]")}
                >
                  Celá Podání (Verze)
                </button>
              </div>
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#444] font-black flex items-center gap-2">
                {selectionMode === 'FILES' ? '(00) REGISTRAČNÍ_INVENTÁŘ_SOUBORŮ' : '(00) EVOLUCE_PŘEDLOŽENÝCH_VERZÍ'}
                <span className="text-[#C5A059] ml-2">[{cases.find(c => c.id === currentCaseId)?.nr}]</span>
                {showArchived && <span className="text-amber-600 ml-2 animate-pulse">[ARCHIV]</span>}
              </h2>
              <div className="flex items-center gap-4 flex-wrap mt-2">
                <div className="relative">
                  <input type="text" value={fileSearch} onChange={(e) => setFileSearch(e.target.value)} placeholder="FILTROVAT..." className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-mono tracking-widest text-[#666] outline-none focus:border-[#C5A059] transition-all w-40" />
                </div>
                {selectionMode === 'VERSIONS' && (
                  <div className="flex gap-2">
                    <button 
                      onClick={() => {
                        const currentVers = Array.from(new Set(uploadedFiles.filter(f => f.caseId === currentCaseId).map(f => f.version || '')));
                        setCompareVersionIds(currentVers.slice(0, 2));
                      }}
                      className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-black text-[#C5A059] hover:bg-[#C5A059] hover:text-black transition-all"
                    >
                      Označit Poslední 2 Verze
                    </button>
                    <button 
                      onClick={() => setCompareVersionIds([])}
                      className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-black text-[#444] hover:text-white transition-all"
                    >
                      Zrušit Výběr
                    </button>
                  </div>
                )}
                {selectionMode === 'FILES' && (
                  <div className="flex gap-2">
                    <select 
                      value={versionFilter} 
                      onChange={(e) => setVersionFilter(e.target.value as any)}
                      className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-black text-[#C5A059] outline-none"
                    >
                      <option value="ALL">VŠECHNY VERZE</option>
                      <option value="CURRENT">AKTUÁLNÍ PODÁNÍ ({currentVersion})</option>
                      <option value="ORPHAN">OSIŘELÉ SOUBORY</option>
                      <optgroup label="SPECIFICKÉ VERZE">
                        {Array.from(new Set(uploadedFiles.filter(f => f.version).map(f => f.version))).map(v => (
                          <option key={v} value={v!}>{v}</option>
                        ))}
                      </optgroup>
                    </select>
                    <button onClick={createNewVersionManually} title="Vytvořit Novou Verzi" className="px-3 bg-blue-900/40 border border-blue-900/60 text-blue-400 text-[10px] uppercase font-black hover:bg-blue-900 transition-all">Nový Upgrade</button>
                    <button onClick={toggleSelectAll} className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-black text-[#444] hover:text-white transition-all">
                      {(filteredFiles.length > 0 && filteredFiles.every(f => selectedBulkIds.includes(f.id))) ? 'Odznačit výběr' : 'Označit výběr'}
                    </button>
                  </div>
                )}
                {selectedBulkIds.length > 0 ? (
                  <div className="flex items-center gap-2 bg-[#C5A059]/10 border border-[#C5A059]/40 px-3 py-1 animate-in fade-in slide-in-from-left-2 transition-all">
                    <span className="text-[9px] font-black text-[#C5A059] mr-2">HROMADNĚ ({selectedBulkIds.length}):</span>
                    <button onClick={() => bulkAction('ADD_TO_AUDIT')} className="text-[9px] uppercase font-bold text-white hover:underline" title="Hromadně označit k auditu">Přidat k Auditu</button>
                    <div className="w-px h-3 bg-[#C5A059]/30 mx-2" />
                    <button onClick={() => bulkAction('RENAME_VERSION')} className="text-[9px] uppercase font-bold text-[#C5A059] hover:underline" title="Hromadně změnit název verze">Přejmenovat Verzi</button>
                    <div className="w-px h-3 bg-[#C5A059]/30 mx-2" />
                    <button onClick={() => setBulkCategory('MAIN')} className="text-[9px] uppercase font-bold text-white hover:underline">Hl. Podání</button>
                    <button onClick={() => setBulkCategory('ATTACH')} className="text-[9px] uppercase font-bold text-blue-400 hover:underline">Příloha</button>
                    <button onClick={() => setBulkCategory('SUPPORT')} className="text-[9px] uppercase font-bold text-emerald-400 hover:underline">Podpora</button>
                    <button onClick={() => setBulkCategory('SYSTEM')} className="text-[9px] uppercase font-bold text-purple-400 hover:underline">Systém</button>
                    <div className="w-px h-3 bg-[#C5A059]/30 mx-2" />
                    <button onClick={() => bulkAction('ASSIGN_CURRENT')} className="text-[9px] uppercase font-bold text-[#C5A059] hover:underline" title="Přiřadit k aktuálnímu spisu/verzi">Přiřadit k aktuálnímu</button>
                    <div className="w-px h-3 bg-[#C5A059]/30 mx-2" />
                    <button onClick={() => bulkAction('ARCHIVE')} className="text-[9px] uppercase font-bold text-amber-500 hover:underline">Archivovat</button>
                    <button onClick={() => bulkAction('DELETE')} className="text-[9px] uppercase font-bold text-red-500 hover:underline">Smazat</button>
                    <button onClick={() => setSelectedBulkIds([])} className="ml-2 text-[#444] hover:text-white"><X size={10}/></button>
                  </div>
                ) : (
                  <>
                    <select value={fileSortBy} onChange={(e) => setFileSortBy(e.target.value as any)} className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-mono text-[#666] outline-none hover:border-[#444]">
                      <option value="ORDER">Řadit: Hierarchie LG13</option>
                      <option value="date">Řadit: Datum</option>
                      <option value="name">Řadit: Název</option>
                      <option value="type">Řadit: Typ</option>
                      <option value="batch">Řadit: Balík (ZIP)</option>
                    </select>
                    <div className="h-4 w-px bg-[#222] mx-2" />
                    <button onClick={() => setShowArchived(!showArchived)} className={cn("text-[10px] uppercase font-black px-3 py-1 border transition-all flex items-center gap-2", showArchived ? "bg-amber-600/10 border-amber-600 text-amber-600" : "border-[#222] text-[#444]")}>
                      <FolderArchive size={12}/> {showArchived ? 'Active Mode' : 'Archiv Mode'}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-4 items-center">
              {uploadedFiles.length > 0 && (
                <select 
                  value={uploadBatchId || ''} 
                  onChange={(e) => setUploadBatchId(e.target.value === '' ? null : e.target.value)}
                  className="bg-[#111] border border-[#222] px-3 py-1 text-[10px] uppercase font-mono text-[#666] outline-none hover:border-[#444]"
                >
                  <option value="">Nový Balík</option>
                  {Array.from(new Set(uploadedFiles.filter(f => f.batchId).map(f => f.batchId))).map(bid => (
                    <option key={bid} value={bid}>Přidat k {bid}</option>
                  ))}
                </select>
              )}
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#666] hover:text-white transition-colors"><Upload size={12} /> Nahrát</button>
              <button 
                onClick={fetchDriveFolderFiles}
                disabled={!driveToken}
                className={cn(
                  "flex items-center gap-2 text-[10px] uppercase tracking-widest transition-colors",
                  driveToken ? "text-[#C5A059] hover:text-white" : "text-[#444] opacity-50"
                )}
                title="Procházet soubory ve složce LG13_Terminal_Data na Google Drive"
              >
                <FolderArchive size={12} /> Procházet Drive
              </button>
              <button 
                onClick={async () => {
                  try {
                    const response = await fetch('/src/assets/test_filing.md');
                    const content = await response.text();
                    const newFile: FileEntry = {
                      id: `SAMPLE-${Date.now()}`,
                      name: 'SAMPLE_ATOMS_PoC.md',
                      type: 'MD',
                      category: 'MAIN',
                      isUploaded: true,
                      timestamp: Date.now(),
                      version: 'F15.4',
                      caseId: currentCaseId,
                      content: content,
                      indexStatus: 'IDLE'
                    };
                    setUploadedFiles(prev => [newFile, ...prev]);
                    alert('Vzorový "Atom" dokument načten.');
                  } catch (err) {
                    console.error('Failed to load sample:', err);
                    alert('Nepodařilo se načíst vzorový dokument.');
                  }
                }}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#C5A059] hover:text-white transition-colors"
                title="Načíst vzorový dokument z lg13-build-from-atoms"
              >
                <FileCode size={12} /> Načíst Vzor
              </button>
               <button 
                onClick={reconcileDrive} 
                disabled={isReconciling || !driveToken}
                className={cn(
                  "flex items-center gap-2 text-[10px] uppercase tracking-widest transition-colors",
                  isDriveEnabled ? "text-[#C5A059] hover:text-white" : "text-[#444] opacity-50"
                )}
                title="Hloubková synchronizace: Upload lokálních a Download chybějících souborů z Drive"
              >
                {isReconciling ? <RefreshCcw size={12} className="animate-spin" /> : <Layers size={12} />} 
                {isReconciling ? 'Slaďuji...' : 'Reconcile Cloud'}
              </button>
              <button 
                onClick={syncDriveFiles} 
                disabled={isSyncingDrive || !driveToken}
                className={cn(
                  "flex items-center gap-2 text-[10px] uppercase tracking-widest transition-colors",
                  isDriveEnabled ? "text-[#C5A059] hover:text-white" : "text-[#444] opacity-50"
                )}
              >
                {isSyncingDrive ? <RefreshCcw size={12} className="animate-spin" /> : <Database size={12} />} 
                {isSyncingDrive ? 'Synchronizuji...' : 'Sync Google Drive'}
              </button>
              <button 
                onClick={syncGitHubFiles} 
                disabled={isSyncingGitHub}
                className={cn(
                  "flex items-center gap-2 text-[10px] uppercase tracking-widest transition-colors",
                  isGitHubEnabled ? "text-white hover:text-[#C5A059]" : "text-[#444] opacity-50"
                )}
              >
                {isSyncingGitHub ? <RefreshCcw size={12} className="animate-spin" /> : <Github size={12} />} 
                {isSyncingGitHub ? 'GitHub Sync...' : 'Sync GitHub'}
              </button>
              <input type="file" ref={fileInputRef} onChange={handleFileUpload} multiple className="hidden" />
            </div>
          </div>

          <div className={cn(selectionMode === 'VERSIONS' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" : "grid grid-cols-2 lg:grid-cols-6 gap-4")}>
            {selectionMode === 'VERSIONS' ? (
              Array.from(new Set(uploadedFiles.filter(f => f.caseId === currentCaseId).map(f => f.version))).sort().reverse().map(ver => {
                const isSelected = compareVersionIds.includes(ver);
                const filesInVer = uploadedFiles.filter(f => f.version === ver && f.caseId === currentCaseId);
                return (
                  <div 
                    key={ver}
                    onClick={() => {
                      if (isSelected) setCompareVersionIds(prev => prev.filter(id => id !== ver));
                      else if (compareVersionIds.length < 2) setCompareVersionIds(prev => [...prev, ver]);
                    }}
                    className={cn(
                      "group relative border-2 p-6 transition-all cursor-pointer overflow-hidden",
                      isSelected ? "border-[#C5A059] bg-[#C5A059]/5 shadow-[0_0_30px_rgba(197,160,89,0.1)]" : "border-[#111] hover:border-[#222] bg-[#0c0c0c]"
                    )}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <span className={cn("text-sm font-black uppercase tracking-tighter block", isSelected ? "text-[#C5A059]" : "text-white")}>{ver}</span>
                        <div className="text-[8px] text-[#444] font-mono mt-1">ID: {ver.replace(/[^a-zA-Z0-9]/g, '_')}</div>
                      </div>
                      {isSelected ? <ShieldCheck size={18} className="text-[#C5A059]" /> : <Layers size={18} className="text-[#222]" />}
                    </div>
                    
                    <div className="space-y-1 mb-4">
                      {filesInVer.slice(0, 3).map(f => (
                        <div key={f.id} className="text-[9px] text-[#666] truncate flex items-center gap-2">
                           <div className="w-1 h-1 rounded-full bg-[#333]" /> {f.name}
                        </div>
                      ))}
                      {filesInVer.length > 3 && <div className="text-[8px] text-[#333] italic">+ {filesInVer.length - 3} dalších příloh</div>}
                    </div>

                    <div className="flex items-center justify-between pt-4 border-t border-[#222]">
                      <div className="text-[9px] font-black text-white">{filesInVer.length} SOUBORŮ</div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); assignVersionToCase(ver); }}
                        className="text-[8px] font-black bg-[#222] px-2 py-1 text-[#666] hover:text-white hover:bg-[#333] transition-all uppercase"
                      >
                        Přiřadit ke spisu
                      </button>
                      {isSelected && (
                        <div className="text-[8px] font-black uppercase text-[#C5A059]">
                          {compareVersionIds.indexOf(ver) === 0 ? 'SOURCE (ZÁKLAD)' : 'TARGET (PŘÍRASTK)'}
                        </div>
                      )}
                    </div>
                    {isSelected && <div className="absolute top-0 right-0 w-2 h-full bg-[#C5A059]" />}
                  </div>
                )
              })
            ) : (
              filteredFiles.map((file) => {
              const isSelected = selectedFileIds.includes(file.id);
              const isSupport = supportFileIds.includes(file.id);
              const isBulk = selectedBulkIds.includes(file.id);
              return (
                <div key={file.id} className="group relative">
                <div 
                  className={cn(
                    "border p-3 transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between min-h-[90px]",
                    isBulk ? "border-white bg-white/10" : 
                    isSelected ? "border-[#C5A059] bg-[#C5A059]/10 shadow-[0_0_15px_rgba(197,160,89,0.1)]" : 
                    isSupport ? "border-emerald-600 bg-emerald-950/20" : 
                    getFileColor(file)
                  )}
                >
                  <div className="text-[8px] font-mono text-[#666] uppercase mb-1 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                       {file.batchId && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: `hsl(${file.batchId.split('').reduce((a,b)=>a+b.charCodeAt(0),0)%360}, 70%, 50%)` }} title={`Batch: ${file.batchId}`} />}
                       <span>{file.batchId || file.id}</span>
                    </div>
                    <input 
                      type="checkbox" 
                      checked={isBulk} 
                      onChange={() => toggleFileSelection(file.id, 'BULK')}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-[#C5A059] h-3 w-3 cursor-pointer"
                    />
                  </div>
                  <div 
                    onClick={() => !file.isArchived && toggleFileSelection(file.id, 'SELECT')}
                    onContextMenu={(e) => { e.preventDefault(); toggleFileSelection(file.id, 'SUPPORT'); }}
                    className={cn("text-[10px] font-black leading-tight truncate mb-2 flex items-center gap-2", isSelected ? "text-white" : isSupport ? "text-emerald-400" : "text-[#999]")}
                  >
                    {isSelected && <Sparkles size={10} className="text-[#C5A059] shrink-0 animate-pulse" />}
                    {file.name}
                    <div className="ml-auto flex gap-1 items-center">
                      {file.content && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/50" title="Obsah načten lokálně" />}
                      {file.driveId && <Database size={8} className="text-[#C5A059]" />}
                      {file.indexStatus === 'INDEXING' && <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" title="Probíhá indexace..." />}
                      {file.indexStatus === 'DONE' && <div className="w-1.5 h-1.5 rounded-full bg-[#C5A059]" title="Indexováno se znalostí okolí" />}
                      {file.indexStatus === 'ERROR' && <div className="w-1.5 h-1.5 rounded-full bg-red-500" title="Chyba indexace" />}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="px-1.5 py-0.5 bg-[#1a1a1a] text-[#888] text-[7px] font-mono rounded border border-[#222] uppercase">{file.category || file.type}</span>
                    <div className="flex gap-1 items-center">
                      {file.type === 'PDF' && <button onClick={(e) => { e.stopPropagation(); setPreviewFile(file); }} className="p-1 hover:text-[#C5A059] transition-colors"><Eye size={8}/></button>}
                      {isSelected && <span className="text-[7px] font-black text-[#C5A059]">OBJ</span>}
                          {isSupport && <span className="text-[7px] font-black text-emerald-500">REF</span>}
                        </div>
                      </div>
                    </div>
                    <div className="absolute -top-2 -right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-all scale-75 group-hover:scale-100 z-10">
                      {file.isArchived ? (
                        <button onClick={(e) => { e.stopPropagation(); restoreFile(file.id); }} className="bg-[#111] border border-[#222] p-1.5 rounded-full hover:bg-emerald-900 text-emerald-500"><RotateCcw size={10}/></button>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); archiveFile(file.id); }} className="bg-[#111] border border-[#222] p-1.5 rounded-full hover:bg-amber-900 text-amber-500"><FolderArchive size={10}/></button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); deleteFile(file.id); }} className="bg-[#111] border border-[#222] p-1.5 rounded-full hover:bg-red-900 text-red-500"><Trash2 size={10}/></button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#444] font-black flex items-center gap-2">
              <ListFilter size={14}/> (00a) KONFIGURACE_AUDITNÍCH_PILÍŘŮ
            </h2>
            <div className="flex gap-2">
              <button 
                onClick={() => toggleAllPillars(true)}
                className="text-[9px] font-black uppercase text-[#C5A059] border border-[#C5A059]/20 px-3 py-1 hover:bg-[#C5A059]/10 transition-all"
              >
                Všechny Pilíře
              </button>
              <button 
                onClick={() => toggleAllPillars(false)}
                className="text-[9px] font-black uppercase text-[#666] border border-[#222] px-3 py-1 hover:text-white transition-all"
              >
                Vyčistit
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {auditPillars.map((pillar) => {
              const isSelected = selectedPillarIds.includes(pillar.id);
              return (
                <div key={pillar.id} onClick={() => togglePillarSelection(pillar.id)} className={cn("border p-4 transition-all cursor-pointer relative group", isSelected ? "border-[#C5A059] bg-[#C5A059]/5" : "border-[#151515] bg-[#0A0A0A] opacity-50 grayscale hover:opacity-100")}>
                  <div className="flex items-start justify-between mb-2">
                    <div className={cn("text-[9px] font-black uppercase tracking-widest flex items-center gap-2", isSelected ? "text-[#C5A059]" : "text-[#555]")}>
                      {pillar.icon} {pillar.name}
                    </div>
                    <div className={cn("h-3 w-3 border flex items-center justify-center transition-colors", isSelected ? "border-[#C5A059] bg-[#C5A059]" : "border-[#333]")}>
                      {isSelected && <Check size={8} className="text-black" />}
                    </div>
                  </div>
                  <p className={cn("text-[9px] font-mono leading-relaxed", isSelected ? "text-[#888]" : "text-[#333]")}>{pillar.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-12">
          <div className="flex items-center justify-between mb-4">
             <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#444] font-black flex items-center gap-2">
              <FileDown size={14}/> (01a) POKYNY_K_REDAKCI_A_DRAFTŮM
            </h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[8px] uppercase font-black text-[#555] tracking-widest pl-1">Všeobecný kontext / Git Repo</label>
              <input 
                type="text"
                value={gitContext}
                onChange={(e) => setGitContext(e.target.value)}
                placeholder="https://github.com/..."
                className="w-full bg-[#111] border border-[#222] px-4 py-2 text-[10px] font-mono text-[#C5A059] outline-none focus:border-[#C5A059]"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[8px] uppercase font-black text-[#555] tracking-widest pl-1">Specifické Auditní Poznámky</label>
              <textarea 
                value={notes} 
                onChange={(e) => setNotes(e.target.value)} 
                placeholder="Zadejte doplňující poznámky pro AI (např. 'Zohledni judikát o péči z 2024')..."
                className="w-full bg-[#151515] border border-[#222] p-4 text-xs font-mono text-[#777] outline-none focus:border-[#C5A059] h-24 custom-scrollbar"
              />
            </div>
          </div>
        </section>

        <section className="mb-12">
          <div className="border-l-2 border-[#222] pl-8 py-6 flex flex-col lg:flex-row justify-between items-start gap-12 bg-gradient-to-r from-[#0A0A0A] to-transparent">
            <div className="flex-1">
              <h2 className="text-[10px] uppercase tracking-[0.4em] text-[#444] font-black mb-6">DYNAMICKÝ_PLÁN_AUDITU_PRO_{currentVersion}</h2>
              <div className="flex flex-wrap gap-8">
                <div><div className="text-[9px] text-[#444] font-mono uppercase mb-2">Kontext</div><div className="text-lg font-black text-[#999]">{selectedFileIds.length} SOUBORŮ</div></div>
                <div><div className="text-[9px] text-[#444] font-mono uppercase mb-2">Reference</div><div className="text-lg font-black text-emerald-900">{supportFileIds.length} SOUBORŮ</div></div>
                <div><div className="text-[9px] text-[#444] font-mono uppercase mb-2">Auditní Šíře</div><div className="text-lg font-black text-[#C5A059]">{selectedPillarIds.length} METRIK</div></div>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex gap-2 bg-[#151515] border border-[#222] p-1">
                <button 
                  onClick={() => setQueueStrategy('COMBINE')} 
                  className={cn("px-4 py-2 text-[9px] uppercase font-black transition-all", queueStrategy === 'COMBINE' ? "bg-[#C5A059] text-black" : "text-[#666] hover:text-white")}
                  title="Všechny vybrané soubory v jedné analýze"
                >
                  Kombinovat
                </button>
                <button 
                  onClick={() => setQueueStrategy('PER_FILE')} 
                  className={cn("px-4 py-2 text-[9px] uppercase font-black transition-all", queueStrategy === 'PER_FILE' ? "bg-[#C5A059] text-black" : "text-[#666] hover:text-white")}
                  title="Každý soubor jako samostatná úloha"
                >
                  Per Soubor
                </button>
                <button 
                  onClick={() => setQueueStrategy('CROSS')} 
                  className={cn("px-4 py-2 text-[9px] uppercase font-black transition-all", queueStrategy === 'CROSS' ? "bg-[#C5A059] text-black" : "text-[#666] hover:text-white")}
                  title="Každý soubor x každý pilíř = samostatná úloha"
                >
                  Matrix
                </button>
              </div>
              <button 
                onClick={addToQueue} 
                disabled={selectionMode === 'FILES' ? selectedFileIds.length === 0 : compareVersionIds.length === 0} 
                className={cn("px-12 py-5 text-[12px] font-black uppercase tracking-[0.4em] border transition-all group relative overflow-hidden", (selectionMode === 'FILES' ? selectedFileIds.length === 0 : compareVersionIds.length === 0) ? "border-[#222] text-[#333] cursor-not-allowed" : "border-[#C5A059] text-[#C5A059] hover:bg-[#C5A059] hover:text-black")}
              >
                <span className="relative z-10 flex items-center gap-3">
                  {uploadedFiles.some(f => f.indexStatus === 'INDEXING') && <Loader2 size={16} className="animate-spin" />}
                  {uploadedFiles.some(f => f.indexStatus === 'INDEXING') ? 'Probíhá Indexace Balíku...' : 'Zahájit Auditní Úlohu'}
                </span>
                {uploadedFiles.some(f => f.indexStatus === 'INDEXING') && (
                  <motion.div 
                    initial={{ width: 0 }} 
                    animate={{ width: '100%' }} 
                    transition={{ duration: 10, repeat: Infinity }}
                    className="absolute bottom-0 left-0 h-1 bg-[#C5A059]/20"
                  />
                )}
              </button>
            </div>
          </div>
        </section>

        {auditQueue.length > 0 && (
          <section className="mb-20">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#444] font-black flex items-center gap-2">
                <RefreshCcw size={14} className={cn(isQueueRunning && "animate-spin text-[#C5A059]")}/> 
                (00b) FRONTA_AUDITNÍCH_ÚLOH 
                {isQueueRunning && <span className="text-[#C5A059] ml-2 animate-pulse font-mono">[PROBÍHÁ SEKVENČNÍ ZPRACOVÁNÍ]</span>}
              </h2>
              <div className="flex gap-4">
                <div className="flex bg-[#111] border border-[#222] p-1 gap-1">
                  {isQueueRunning ? (
                    <button 
                      onClick={stopQueue} 
                      className="px-3 py-1 text-[9px] uppercase font-black text-red-500 hover:bg-red-500/10 transition-all flex items-center gap-2"
                    >
                      <X size={10}/> Zastavit
                    </button>
                  ) : (
                    <button 
                      onClick={clearQueue} 
                      disabled={auditQueue.length === 0}
                      className="px-3 py-1 text-[9px] uppercase font-black text-[#555] hover:text-red-500 transition-all disabled:opacity-30 flex items-center gap-2"
                    >
                      <Trash2 size={10}/> Vymazat frontu
                    </button>
                  )}
                  <button 
                    onClick={() => downloadAllResults(true)} 
                    disabled={auditQueue.filter(t => t.status === 'done' && t.timestamp >= new Date().setHours(0,0,0,0)).length === 0}
                    className="px-3 py-1 text-[9px] uppercase font-black text-emerald-500 hover:bg-emerald-500/10 transition-all disabled:opacity-30 flex items-center gap-2"
                  >
                    <Download size={10}/> Dnešní (ZIP)
                  </button>
                  <button 
                    onClick={() => downloadAllResults(false)} 
                    disabled={auditQueue.filter(t => t.status === 'done').length === 0}
                    className="px-3 py-1 text-[9px] uppercase font-black text-blue-500 hover:bg-blue-500/10 transition-all disabled:opacity-30 flex items-center gap-2"
                  >
                    <Archive size={10}/> Vše (ZIP)
                  </button>
                </div>
                <button 
                  onClick={executeAllQueue} 
                  disabled={isQueueRunning || isReviewing || auditQueue.every(t => t.status === 'done')} 
                  className="px-4 py-2 border border-[#C5A059] text-[10px] uppercase font-black text-[#C5A059] hover:bg-[#C5A059] hover:text-black transition-all disabled:opacity-30 flex items-center gap-2"
                >
                  {isQueueRunning ? <Loader2 size={12} className="animate-spin"/> : <RefreshCcw size={12}/>}
                  Spustit Všechny Úlohy
                </button>
              </div>
            </div>
            <div className="grid gap-2">
              {auditQueue.map((item) => (
                <div key={item.id} onClick={() => item.status === 'done' && setActiveQueueId(item.id)} className={cn("flex flex-col md:flex-row md:items-center justify-between border p-4 group transition-all relative overflow-hidden", item.status === 'done' ? "bg-[#0A0A0A] border-[#222] cursor-pointer hover:border-[#444]" : "bg-[#050505] border-[#111]", activeQueueId === item.id && "border-[#C5A059] bg-[#C5A059]/5", currentProcessingId === item.id && "border-blue-500 bg-blue-500/5")}>
                   {(item.status === 'processing' || currentProcessingId === item.id) && <motion.div initial={{ x: '-100%' }} animate={{ x: '100%' }} transition={{ duration: 2, repeat: Infinity, ease: 'linear' }} className="absolute bottom-0 left-0 h-[1px] w-full bg-[#C5A059] opacity-50" />}
                   <div className="flex items-center gap-6 overflow-hidden">
                    <div className={cn("text-[10px] font-mono", item.status === 'processing' ? "text-[#C5A059]" : "text-[#333] opacity-50")}>{item.id}</div>
                    <div className="flex flex-col gap-1">
                      <div className={cn("text-[10px] font-black tracking-widest uppercase", item.status === 'done' ? "text-[#888]" : "text-[#666]")}>
                        {item.version} // {item.files[0]} {item.files.length > 1 ? `+ ${item.files.length - 1} další` : ''}
                      </div>
                      <div className="text-[8px] font-mono text-[#333] truncate italic opacity-50">{item.pillars.join(' • ')}</div>
                      {item.status === 'error' && item.error && (
                        <div className="text-[8px] text-red-500/70 font-mono mt-1 max-w-sm truncate">{item.error}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-4 md:mt-0">
                    <div className={cn("text-[9px] font-bold px-2 py-1 uppercase flex items-center gap-2", 
                      item.status === 'pending' ? "text-[#444] bg-[#222]/20" : 
                      item.status === 'processing' ? "text-[#C5A059] bg-[#C5A059]/10 animate-pulse" : 
                      item.status === 'error' ? "text-red-500 bg-red-500/10 border border-red-500/20" :
                      "text-emerald-500 bg-emerald-500/10"
                    )}>
                      {item.status === 'processing' && <Loader2 size={8} className="animate-spin"/>}
                      {item.status === 'error' && <AlertCircle size={8} />}
                      {item.status}
                    </div>
                    <div className="flex gap-2">
                       {(item.status === 'pending' || item.status === 'error') && !isQueueRunning && <button onClick={(e) => { e.stopPropagation(); handleReview(item.id); }} className="p-2 border border-[#C5A059]/40 text-[#C5A059] hover:bg-[#C5A059] hover:text-black transition-all" title="Spustit úlohu"><Send size={14}/></button>}
                       {item.status === 'done' && <button onClick={(e) => { e.stopPropagation(); downloadReport(item.id); }} className="p-2 border border-[#222] text-[#444] hover:text-white transition-all"><Download size={14}/></button>}
                       <button onClick={(e) => { e.stopPropagation(); removeFromQueue(item.id); if (activeQueueId === item.id) setActiveQueueId(null); }} className="p-2 border border-[#222] text-red-950 hover:text-red-500 transition-all"><Trash2 size={14}/></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-12 lg:grid-cols-12 border-t border-[#111] pt-12">
          <section className="lg:col-span-12 space-y-8">
            <div className="flex items-center justify-between bg-[#151515] border border-[#222] px-6 py-3">
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#C5A059] font-black">
                {appMode === 'AUDIT' ? '(01) PETIČNÍ_STRING_TERMINÁL' : '(01) DRAFTING_COMPOSITION_ENGINE'}
              </h2>
              <div className="flex gap-4">
                <button onClick={createNewVersion} className="text-[10px] uppercase font-black text-amber-600 hover:text-amber-500 transition-colors">Vytvořit Snapshot (Záloha)</button>
                <button onClick={() => setInputText('')} className="text-[10px] uppercase font-black text-[#666] hover:text-white transition-colors">Vymazat</button>
              </div>
            </div>
            <textarea 
              value={inputText} 
              onChange={(e) => setInputText(e.target.value)} 
              placeholder={appMode === 'AUDIT' ? "ZADEJTE PRÁVNÍ ARGUMENTACI..." : "Zadejte pokyny pro sestavení nového dokumentu ze zdrojů..."} 
              className="min-h-[400px] w-full border border-[#222] bg-[#151515] p-10 text-xl font-serif italic text-[#EEE] outline-none transition-all focus:border-[#C5A059] custom-scrollbar selection:bg-amber-900 shadow-2xl" 
            />
            <div className="space-y-4">
              <button 
                onClick={() => handleReview()} 
                disabled={isReviewing || (!inputText.trim() && selectedFileIds.length === 0 && (selectionMode === 'FILES' ? true : compareVersionIds.length === 0))} 
                className={cn(
                  "w-full py-8 text-sm font-black uppercase tracking-[0.5em] border transition-all flex items-center justify-center gap-4 group", 
                  isReviewing ? "border-amber-700 text-amber-700 cursor-wait" : 
                  (!inputText.trim() && selectedFileIds.length === 0 && (selectionMode === 'FILES' ? true : compareVersionIds.length === 0)) ? "border-[#222] text-[#333] cursor-not-allowed" :
                  "border-[#C5A059] text-white hover:bg-[#C5A059] hover:text-black"
                )}
              >
                {isReviewing ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} className={cn((selectedFileIds.length > 0 || compareVersionIds.length > 0) ? "animate-pulse" : "")} />}
                {isReviewing ? 'Drtím_Data...' : 
                  (selectionMode === 'VERSIONS' && compareVersionIds.length === 2) ? `POROVNAT ${compareVersionIds[0]} ➔ ${compareVersionIds[1]}` :
                  (selectionMode === 'VERSIONS' && compareVersionIds.length === 1) ? `AUDIT VERZE ${compareVersionIds[0]}` :
                  (!inputText.trim() && selectedFileIds.length > 0) ? `SPUSTIT AUDIT ${selectedFileIds.length} SOUBORŮ` : 
                  appMode === 'AUDIT' ? 'Spustit Analýzu Textu' : 'Sestavit Finální Návrh'}
              </button>
              {selectionMode === 'VERSIONS' && compareVersionIds.length === 0 && !isReviewing && (
                <div className="bg-blue-950/20 border border-blue-900/40 p-4 text-center">
                  <p className="text-[10px] font-black uppercase text-blue-400 tracking-widest flex items-center justify-center gap-2">
                    <AlertCircle size={14}/> VYBERTE JEDNU NEBO DVĚ VERZE K ANALÝZE
                  </p>
                </div>
              )}
              {selectionMode === 'FILES' && !inputText.trim() && selectedFileIds.length === 0 && !isReviewing && (
                <div className="bg-amber-950/20 border border-amber-900/40 p-4 text-center">
                  <p className="text-[10px] font-black uppercase text-[#C5A059] tracking-widest flex items-center justify-center gap-2">
                    <AlertCircle size={14}/> K AUDITU JE NUTNÉ VYBRAT SOUBORY (KLIKNĚTE NA NÁZEV) NEBO ZADAT TEXT
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="lg:col-span-12 space-y-8 mb-20 scroll-mt-12" id="audit-output">
            <div id="audit-output-content" className="space-y-8">
              <div className="flex items-center justify-between border-b border-[#222] pb-6 no-print">
              <h2 className="text-[11px] uppercase tracking-[0.2em] text-[#777] font-black">(02) ANALYTICKÝ_AUDITNÍ_PROTOKOL</h2>
              {(reviewResult || (activeQueueId && auditQueue.find(t => t.id === activeQueueId)?.result)) && (
                <div className="flex gap-4">
                  <div className="flex gap-1 bg-[#111] p-1 border border-[#222]">
                    <button onClick={() => setViewMode('HTML')} className={cn("px-2 py-1 text-[8px] font-black uppercase transition-all", viewMode === 'HTML' ? "bg-[#C5A059] text-black" : "text-[#444]")}>Protocol</button>
                    <button onClick={() => setViewMode('MD')} className={cn("px-2 py-1 text-[8px] font-black uppercase transition-all", viewMode === 'MD' ? "bg-[#C5A059] text-black" : "text-[#444]")}>Markdown</button>
                    <button onClick={() => setViewMode('JSON')} className={cn("px-2 py-1 text-[8px] font-black uppercase transition-all", viewMode === 'JSON' ? "bg-[#C5A059] text-black" : "text-[#444]")}>JSON</button>
                  </div>
                  <div className="flex gap-4">
                    <button onClick={() => speakText(reviewResult)} className="text-[10px] uppercase font-black text-[#555] hover:text-emerald-500 flex items-center gap-2"><RefreshCcw size={14}/> Číst nahlas</button>
                    <button onClick={handleCopy} className="text-[10px] uppercase font-black text-[#555] hover:text-[#C5A059] flex items-center gap-2">{isCopied ? <Check size={14}/> : <Copy size={14}/>} {isCopied ? 'Uloženo' : 'Kopírovat'}</button>
                    <button onClick={printReport} className="text-[10px] uppercase font-black text-[#555] hover:text-white flex items-center gap-2"><FileDown size={14}/> Tisk / PDF</button>
                    <button onClick={() => activeQueueId && downloadReport(activeQueueId)} className="text-[10px] uppercase font-black text-[#555] hover:text-white flex items-center gap-2"><Download size={14}/> MD</button>
                  </div>
                </div>
              )}
            </div>
            <div className="min-h-[600px] bg-[#151515] border border-[#222] relative p-12 shadow-2xl custom-scrollbar-thin">
              <AnimatePresence mode="wait">
                {isReviewing ? (
                  <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 flex flex-col items-center justify-center bg-[#050505]/95 z-20">
                    <Loader2 size={40} className="animate-spin text-[#C5A059] mb-6 opacity-40" />
                    <div className="text-[10px] font-mono tracking-[0.8em] text-[#C5A059] uppercase animate-pulse">Dekonstrukce_Argumentů</div>
                  </motion.div>
                ) : (reviewResult || (activeQueueId && auditQueue.find(t => t.id === activeQueueId)?.result)) ? (
                  <motion.div key="result" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="prose prose-invert prose-sm max-w-none prose-headings:text-white prose-p:text-[#999] prose-p:font-serif prose-p:italic prose-p:text-lg prose-strong:text-white prose-blockquote:border-l-[#C5A059] prose-blockquote:bg-[#111] prose-table:border-[#222]">
                    {viewMode === 'MD' && (
                      <ReactMarkdown>{activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result || '' : reviewResult || ''}</ReactMarkdown>
                    )}
                    {viewMode === 'JSON' && (
                      <div className="bg-[#050505] p-6 border border-[#222]">
                        <pre className="text-[10px] font-mono text-[#C5A059] overflow-x-auto">
                          {JSON.stringify(parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined), null, 2)}
                          {!parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined) && "// Žádná strukturovaná data k zobrazení"}
                        </pre>
                      </div>
                    )}
                    {viewMode === 'HTML' && (
                      <div className="space-y-12 not-prose">
                        <div className="flex items-center gap-4">
                          <div className="h-px flex-1 bg-gradient-to-r from-transparent to-[#333]" />
                          <span className="text-[9px] font-black uppercase text-[#444] tracking-[0.4em]">§LG13§_DASHBOARD_v4</span>
                          <div className="h-px flex-1 bg-gradient-to-l from-transparent to-[#333]" />
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          <div className="border border-[#222] p-6 bg-[#111]">
                            <h3 className="text-[10px] font-black uppercase text-[#666] mb-4 flex items-center gap-2">
                              <CheckCircle2 size={14} className="text-emerald-500" /> Stav Dokumentace
                            </h3>
                            <div className="space-y-3 font-mono text-[9px] uppercase">
                              <div className="flex justify-between border-b border-[#222] pb-1"><span>ID:</span><span className="text-white">#{activeQueueId?.substring(0,6) || 'CORE'}</span></div>
                              <div className="flex justify-between border-b border-[#222] pb-1"><span>Spis:</span><span className="text-white">{cases.find(c => c.id === currentCaseId)?.nr}</span></div>
                              <div className="flex justify-between border-b border-[#222] pb-1"><span>Verze:</span><span className="text-white">{currentVersion}</span></div>
                              <div className="flex justify-between"><span>Audit:</span><span className="text-emerald-500">SCHVÁLENO</span></div>
                            </div>
                          </div>
                          
                          <div className="border border-[#222] p-6 bg-[#111] flex flex-col items-center justify-center text-center relative overflow-hidden">
                            <h3 className="text-[10px] font-black uppercase text-[#666] mb-4">
                              {(selectionMode === 'VERSIONS' || (activeQueueId && auditQueue.find(t => t.id === activeQueueId)?.version?.includes('+'))) ? 'Evoluční_Score' : 'Integrita_Score'}
                            </h3>
                            <div className="flex items-end gap-1">
                               <span className="text-6xl font-black text-white leading-none">
                                {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.score || 94}
                               </span>
                               <span className="text-xs text-[#333] mb-2">%</span>
                            </div>
                            {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.improvementPercent !== undefined && (
                              <div className={cn("text-[9px] font-bold mt-2", (parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.improvementPercent > 0) ? "text-emerald-500" : "text-red-500")}>
                                Δ {(parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.improvementPercent > 0) ? '+' : ''}{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.improvementPercent}% oproti základu
                              </div>
                            )}
                            <div className="mt-4 w-full h-1 bg-[#222] rounded-full overflow-hidden">
                               <motion.div initial={{ width: 0 }} animate={{ width: `${parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.score || 94}%` }} className="h-full bg-[#C5A059]" />
                            </div>
                            {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.diffStats && (
                              <div className="mt-4 flex gap-4 w-full justify-center">
                                <div className="text-[8px] font-mono text-emerald-500">+{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.diffStats.added} ADD</div>
                                <div className="text-[8px] font-mono text-red-500">-{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.diffStats.removed} DEL</div>
                                <div className="text-[8px] font-mono text-blue-500">~{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.diffStats.changed} CHG</div>
                              </div>
                            )}

                            {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.metrics && (
                              <div className="mt-4 grid grid-cols-2 gap-4 w-full border-t border-[#222] pt-4">
                                <div className="text-center">
                                  <div className="text-[7px] text-[#555] uppercase font-black tracking-widest">Síla (Strength)</div>
                                  <div className="text-lg font-black text-white">{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.metrics.strength}%</div>
                                </div>
                                <div className="text-center">
                                  <div className="text-[7px] text-[#555] uppercase font-black tracking-widest">Prob. Úspěchu</div>
                                  <div className="text-lg font-black text-[#C5A059]">{parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.metrics.probability}%</div>
                                </div>
                              </div>
                            )}

                            {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.verdict && (
                              <div className={cn("mt-4 px-4 py-1 text-[8px] font-black uppercase tracking-widest w-full text-center", 
                                parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.verdict === 'SUBMIT' ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500")}>
                                Verdikt: {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.verdict === 'SUBMIT' ? 'PODAT' : 'DALŠÍ ÚPRAVY'}
                              </div>
                            )}
                          </div>

                          <div className="border border-[#222] p-6 bg-[#111]">
                            <h3 className="text-[10px] font-black uppercase text-[#666] mb-4 flex items-center gap-2">
                              <AlertCircle size={14} className="text-[#C5A059]" /> Klíčová Doporučení
                            </h3>
                            <ul className="space-y-2 text-[10px] font-black uppercase text-[#C5A059]">
                               {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.recommendations?.slice(0,3).map((r: string, i: number) => (
                                 <li key={i} className="flex gap-2"><span>&raquo;</span> <span className="truncate">{r}</span></li>
                               ))}
                               {!parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.recommendations && (
                                 <li className="text-[#333]">Žádná doporučení k zobrazení</li>
                               )}
                            </ul>
                          </div>
                        </div>

                        {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions && (
                          <div className="border border-[#222] p-6 bg-[#0a0a0a]">
                            <h3 className="text-[10px] font-black uppercase text-[#666] mb-6 flex items-center gap-2">
                              <RotateCcw size={14} className="text-blue-500" /> Operační Mapa Změn & Revizí (§LG13§ Protocol)
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                              <div className="space-y-2">
                                <div className="text-[8px] font-black text-emerald-500 uppercase tracking-widest border-b border-emerald-900/30 pb-1">Nově Přidat (+)</div>
                                <ul className="text-[9px] text-[#888] space-y-1">
                                  {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.add?.length > 0 ? (
                                    parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.add.map((item: string, i: number) => (
                                      <li key={i} className="flex gap-2"><span>•</span> {item}</li>
                                    ))
                                  ) : <li className="opacity-30 italic">Žádné nové položky</li>}
                                </ul>
                              </div>
                              <div className="space-y-2">
                                <div className="text-[8px] font-black text-red-500 uppercase tracking-widest border-b border-red-900/30 pb-1">Odstranit (x)</div>
                                <ul className="text-[9px] text-[#888] space-y-1">
                                  {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.remove?.length > 0 ? (
                                    parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.remove.map((item: string, i: number) => (
                                      <li key={i} className="flex gap-2"><span>•</span> {item}</li>
                                    ))
                                  ) : <li className="opacity-30 italic">Žádné položky k odstranění</li>}
                                </ul>
                              </div>
                              <div className="space-y-2">
                                <div className="text-[8px] font-black text-blue-500 uppercase tracking-widest border-b border-blue-900/30 pb-1">Upravit / Refactor (~)</div>
                                <ul className="text-[9px] text-[#888] space-y-1">
                                  {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.modify?.length > 0 ? (
                                    parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.modify.map((item: string, i: number) => (
                                      <li key={i} className="flex gap-2"><span>•</span> {item}</li>
                                    ))
                                  ) : <li className="opacity-30 italic">Žádné úpravy</li>}
                                </ul>
                              </div>
                              <div className="space-y-2">
                                <div className="text-[8px] font-black text-[#C5A059] uppercase tracking-widest border-b border-[#C5A059]/30 pb-1">Vrátit z V-Předchozí (&larr;)</div>
                                <ul className="text-[9px] text-[#888] space-y-1">
                                  {parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.revert?.length > 0 ? (
                                    parseJsonFromResult(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)?.actions.revert.map((item: string, i: number) => (
                                      <li key={i} className="flex gap-2"><span>•</span> {item}</li>
                                    ))
                                  ) : <li className="opacity-30 italic">Žádné reverze</li>}
                                </ul>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="space-y-4">
                           <h3 className="text-[10px] font-black uppercase text-[#666] tracking-widest pl-4 border-l-2 border-[#222]">Právní Atomy a Argumenty</h3>
                           <div className="grid gap-2">
                             <div className="bg-[#111] border border-[#222] p-8 font-serif italic text-xl text-[#DDD] leading-relaxed relative group overflow-hidden">
                            <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-100 transition-all flex gap-2">
                                   <button onClick={generatePDF} className="p-2 border border-[#333] hover:border-[#C5A059] text-[#666] hover:text-[#C5A059] flex items-center gap-2 text-[10px] uppercase font-black tracking-widest bg-black/50 backdrop-blur-sm">
                                     <Download size={14}/> PDF Report
                                   </button>
                                   <button onClick={() => speakText(activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result : reviewResult || undefined)} className="p-2 border border-[#333] hover:border-[#C5A059] text-[#666] hover:text-[#C5A059] bg-black/50 backdrop-blur-sm">
                                     <RefreshCcw size={16}/>
                                   </button>
                                </div>
                                <ReactMarkdown>{activeQueueId ? auditQueue.find(t => t.id === activeQueueId)?.result || '' : reviewResult || ''}</ReactMarkdown>
                             </div>
                           </div>
                        </div>

                        <div className="p-6 bg-emerald-950/10 border border-emerald-900/40 text-center">
                           <div className="text-[8px] font-mono text-emerald-800 uppercase tracking-[0.5em] mb-2">§LG13§ SECURITY GATEWAY</div>
                           <p className="text-[10px] font-black text-emerald-600 uppercase">Synchronizace s GitHub Repo v15.3 [CONCEPT_ACTIVE]</p>
                        </div>
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full opacity-10">
                    <Scale size={60} strokeWidth={1} />
                    <div className="mt-8 text-[10px] font-mono uppercase tracking-[1em]">Vstup_Vyžadován</div>
                  </div>
                )}
              </AnimatePresence>
            </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="mx-auto max-w-7xl px-6 py-20 border-t border-[#222] flex flex-col md:flex-row justify-between items-center gap-12 opacity-80 transition-all">
        <div className="flex gap-20">
          <div><div className="text-[9px] font-black uppercase text-[#666] mb-2 tracking-widest">Integrita_Score</div><div className={cn("text-3xl font-black text-[#EAEAEA] tracking-tighter transition-all", isReviewing && "animate-pulse")}>{dynamicScore}%</div></div>
          <div><div className="text-[9px] font-black uppercase text-[#666] mb-2 tracking-widest">Riziko_Zásahu</div><div className={cn("text-3xl font-black text-[#C5A059] tracking-tighter transition-all", isReviewing && "animate-pulse")}>{dynamicRisk}</div></div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-mono text-[#555] uppercase tracking-[0.2em] mb-2 font-black">&copy; 2026 §LG13§ // CORE_ENGINE_v4</p>
          <div className="flex gap-4 justify-end items-center">
            <button onClick={clearAllData} className="text-[8px] font-black uppercase text-red-950 hover:text-red-600 transition-colors mr-4 flex items-center gap-1">
              <Trash2 size={10}/> Hard Reset
            </button>
            <span className="text-[8px] px-2 py-1 bg-[#1a1a1a] text-emerald-900 rounded border border-emerald-900/30">GITHUB_SYNCED</span>
            <span className="text-[8px] px-2 py-1 bg-[#1a1a1a] text-[#666] rounded border border-[#222]">TLS_ENCRYPTED</span>
            <span className="text-[8px] px-2 py-1 bg-[#1a1a1a] text-[#666] rounded border border-[#222]">NOZ_COMPLIANT</span>
          </div>
        </div>
      </footer>

      <AnimatePresence>
        {showHelp && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] flex items-center justify-center p-8 bg-black/95 backdrop-blur-md">
            <div className="w-full h-full max-w-4xl bg-[#0A0A0A] border border-[#C5A059]/30 flex flex-col shadow-[0_0_50px_rgba(197,160,89,0.1)]">
              <div className="flex items-center justify-between px-8 py-6 border-b border-[#111]">
                <h2 className="text-xl font-black tracking-tighter text-[#C5A059]">§LG13§ // DOKUMENTACE_A_NÁPOVĚDA</h2>
                <button onClick={() => setShowHelp(false)} className="text-[#444] hover:text-white transition-colors"><X size={24}/></button>
              </div>
              <div className="flex-1 overflow-auto p-12 space-y-12 custom-scrollbar">
                <section className="space-y-4">
                  <h3 className="text-[10px] font-black uppercase text-[#666] tracking-[0.4em] flex items-center gap-2 mb-8">
                    <div className="w-2 h-2 bg-[#C5A059] animate-pulse" /> FILOZOFIE SYSTÉMU
                  </h3>
                  <p className="text-lg font-serif italic text-[#999] leading-relaxed">
                    §LG13§ není pouhý editor, ale forenzní orchestrátor právních podání. Systém pracuje na bázi "Právních Atomů" — nejmenších jednotek argumentace, které propojují FAKTA, PRÁVNÍ ZÁKLAD a DŮKAZY (přílohy).
                  </p>
                </section>

                <div className="grid md:grid-cols-2 gap-8">
                  <div className="border border-[#111] p-6 space-y-4">
                    <h4 className="text-[10px] font-black uppercase text-white tracking-widest border-b border-[#222] pb-2">Auditní Režim</h4>
                    <p className="text-[11px] text-[#666] leading-relaxed font-mono uppercase">
                      Prověřuje existující dokumenty. K auditu vyberte soubory pomocí ORANŽOVÉ IKONY nebo hromadnou akcí "PŘIDAT K AUDITU". Referenční soubory (kontext) označte ZELENĚ/ŠEDĚ.
                    </p>
                  </div>
                  <div className="border border-[#111] p-6 space-y-4">
                    <h4 className="text-[10px] font-black uppercase text-white tracking-widest border-b border-[#222] pb-2">Versioning & Snapshot</h4>
                    <p className="text-[11px] text-[#666] leading-relaxed font-mono uppercase">
                      "Vytvořit Snapshot" (dříve Fork) slouží k záloze aktuálního stavu podání. Umožňuje vám vytvořit novou verzi a pokračovat v práci bez ovlivnění předchozích draftů.
                    </p>
                  </div>
                </div>

                <section className="space-y-4 pt-8 border-t border-[#111]">
                  <div className="flex items-center justify-between mb-8">
                    <h3 className="text-[10px] font-black uppercase text-[#666] tracking-[0.4em] flex items-center gap-2">
                       ATOMÁRNÍ ARCHITEKTURA (ZDROJE)
                    </h3>
                    <button 
                      onClick={() => setShowAtoms(!showAtoms)}
                      className="text-[10px] uppercase font-black px-3 py-1 bg-[#C5A059] text-black border border-[#C5A059] hover:bg-white transition-all flex items-center gap-2"
                    >
                      <Database size={10}/> {showAtoms ? 'SKRÝT_ZDROJE' : 'ZOBRAZIT_MAPU_ATOMŮ'}
                    </button>
                  </div>
                  
                  {showAtoms && (
                    <div className="bg-[#050505] p-6 border border-[#C5A059]/30 font-mono text-[10px] space-y-6">
                      <div className="grid md:grid-cols-2 gap-8 text-[#888]">
                        <div className="space-y-4">
                          <div className="text-[#C5A059] font-black border-b border-[#222] pb-1">MASTER_DB (POINTERS)</div>
                          <ul className="space-y-2">
                            <li>• atoms.json (49.5 MB)</li>
                            <li>• tmonkey/data/processed/</li>
                            <li>• status: 87K+ fragmentů</li>
                          </ul>
                        </div>
                        <div className="space-y-4">
                          <div className="text-[#C5A059] font-black border-b border-[#222] pb-1">BUILD_PIPELINE</div>
                          <p>Repozitář <code className="text-white">LG13-21/lg13-build-from-atoms</code> zajišťuje renderování MD do PDF přes Pandoc/XeLaTeX se zachováním atomární struktury.</p>
                        </div>
                      </div>
                      <div className="pt-4 border-t border-[#111] text-[9px] text-[#444] italic">
                        Pro využití v AI auditorech: Nastavte URL repozitáře v horní liště. Systém načte metadata a šablony pro kros-validaci argumentace.
                      </div>
                    </div>
                  )}

                <section className="space-y-4 pt-8 border-t border-[#111]">
                  <div className="flex items-center justify-between mb-8">
                     <h3 className="text-[10px] font-black uppercase text-[#666] tracking-[0.4em] flex items-center gap-2">
                        GOOGLE ONE // DRIVE IDENTITY STATUS
                     </h3>
                     {user && isDriveEnabled && (
                       <div className="text-[10px] uppercase font-black text-emerald-500">
                         Aktivní Záloha: OK
                       </div>
                     )}
                  </div>
                  
                  <div className="grid md:grid-cols-2 gap-8">
                    <div className="bg-[#050505] p-6 border border-[#222] font-mono text-[10px] space-y-4">
                      <div className="flex items-center gap-3 mb-4">
                        <Database size={24} className="text-[#C5A059]" />
                        <div>
                          <p className="text-white">Cloud Storage Allocation</p>
                          <p className="text-[#444]">Google Drive (App Settings Folder)</p>
                          {lastSyncTime && (
                            <p className="text-[8px] text-[#C5A059] mt-1 italic">
                              Poslední synchronizace: {new Date(lastSyncTime).toLocaleTimeString()}
                            </p>
                          )}
                        </div>
                      </div>
                      
                      {driveQuota ? (
                        <div className="space-y-2">
                          <div className="flex justify-between text-[9px] uppercase">
                            <span>Využití: {(driveQuota.usage / (1024*1024*1024)).toFixed(2)} GB</span>
                            <span>Limit: {(driveQuota.limit / (1024*1024*1024)).toFixed(0)} GB</span>
                          </div>
                          <div className="w-full h-1 bg-[#111] rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-[#C5A059]" 
                              style={{ width: `${(driveQuota.usage / driveQuota.limit) * 100}%` }}
                            />
                          </div>
                          <p className="text-[8px] text-[#333] mt-2 italic">
                            Data aplikací LG13 nezatěžují váš běžný prostor, pokud nevyužíváte sdílené složky.
                          </p>
                        </div>
                      ) : (
                        <p className="text-[#333] italic">Informace o kvótě nejsou dostupné. Přihlaste se prosím.</p>
                      )}
                    </div>

                    <div className="bg-[#050505] p-6 border border-[#222] font-mono text-[10px] space-y-4">
                       <h4 className="text-white uppercase mb-2 underline">Operace s Cloudem</h4>
                       <div className="grid gap-2">
                          <button 
                            onClick={reconcileDrive}
                            disabled={isReconciling || !driveToken}
                            className="w-full py-2 bg-[#C5A059]/10 border border-[#C5A059]/40 text-[#C5A059] font-black uppercase hover:bg-[#C5A059] hover:text-black transition-all flex items-center justify-center gap-2"
                          >
                             {isReconciling ? <RefreshCcw size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                             Spustit Rekonciliaci (Full Sync)
                          </button>
                          <button 
                            onClick={() => {
                              if (confirm('Tato akce uvolní lokální paměť prohlížeče vymazáním obsahu souborů, které jsou již na Drive. Obsah se stáhne až při analýze.')) {
                                setUploadedFiles(prev => prev.map(f => f.driveId ? { ...f, content: undefined } : f));
                              }
                            }}
                            className="w-full py-2 bg-blue-900/10 border border-blue-900/40 text-blue-400 font-black uppercase hover:bg-blue-900 hover:text-white transition-all"
                          >
                             Uvolnit lokální mezipaměť (Pridat na Drive)
                          </button>
                       </div>
                    </div>
                  </div>
                </section>

                <div className="bg-[#050505] p-6 border border-[#222] font-mono text-[10px] space-y-4">
                    <div className="flex items-center justify-between mb-2">
                        <h4 className="text-white uppercase underline flex items-center gap-2">
                            <Github size={14} /> GitHub Synchronizace (Ship Sync)
                        </h4>
                        <div className="flex items-center gap-2">
                             <span className="text-[8px] text-[#444]">Stav:</span>
                             <div className={cn("w-2 h-2 rounded-full", isGitHubEnabled && gitHubToken ? "bg-emerald-500" : "bg-red-500")} />
                        </div>
                    </div>
                    
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1">
                                <label className="text-[#444] text-[8px] uppercase font-black">Repozitář (owner/repo)</label>
                                <input 
                                    type="text" 
                                    value={gitHubRepo} 
                                    onChange={(e) => setGitHubRepo(e.target.value)}
                                    placeholder="owner/repo"
                                    className="w-full bg-[#111] border border-[#222] px-3 py-1.5 text-[#C5A059] outline-none focus:border-[#C5A059]"
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-[#444] text-[8px] uppercase font-black">Personal Access Token (PAT)</label>
                                <input 
                                    type="password" 
                                    value={gitHubToken || ''} 
                                    onChange={(e) => setGitHubToken(e.target.value || null)}
                                    placeholder="ghp_..."
                                    className="w-full bg-[#111] border border-[#222] px-3 py-1.5 text-[#C5A059] outline-none focus:border-[#C5A059]"
                                />
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <button 
                                onClick={syncGitHubFiles}
                                disabled={isSyncingGitHub}
                                className="flex-1 py-2 bg-white/5 border border-white/10 text-white font-black uppercase hover:bg-white/10 transition-all flex items-center justify-center gap-2"
                            >
                                {isSyncingGitHub ? <RefreshCcw size={12} className="animate-spin" /> : <RefreshCcw size={12} />}
                                Synchronizovat z GitHubu
                            </button>
                            <button 
                                onClick={() => setIsGitHubEnabled(!isGitHubEnabled)}
                                className={cn(
                                    "px-4 py-2 text-[8px] font-black uppercase border transition-all",
                                    isGitHubEnabled ? "bg-[#333] text-white border-[#444]" : "bg-red-950/20 text-red-500 border-red-500/40"
                                )}
                            >
                                {isGitHubEnabled ? 'Deaktivovat' : 'Aktivovat GitHub'}
                            </button>
                        </div>
                        <p className="text-[8px] text-[#444] leading-relaxed italic">
                            GitHub sync načítá soubory ze složky `LG13_Terminal_Data` nebo z kořenového adresáře. Vyžaduje PAT s oprávněním `repo`.
                        </p>
                    </div>
                  </div>
                </section>

                <section className="space-y-4 pt-8 border-t border-[#111]">
                  <div className="space-y-4">
                    <div className="flex items-center gap-4 text-[10px] font-mono">
                      <div className="px-2 py-1 bg-[#222] text-white">SELECT</div>
                      <span className="text-[#444]">LMB na soubor pro výběr k analýze.</span>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-mono">
                      <div className="px-2 py-1 bg-[#222] text-white">CONTEXT</div>
                      <span className="text-[#444]">RMB na soubor pro označení jako REFERENCE (Kontext).</span>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] font-mono">
                      <div className="px-2 py-1 bg-[#222] text-white">BULK_CHECK</div>
                      <span className="text-[#444]">Checkbox pro hromadné operace (Kategorie, Smazání, Archivace).</span>
                    </div>
                  </div>
                </section>

                <div className="p-8 bg-[#C5A059]/5 border border-[#C5A059]/20">
                  <p className="text-[9px] font-mono text-[#C5A059] uppercase leading-relaxed font-black">
                    UPOZORNĚNÍ: SYSTÉM VYŽADUJE AKTIVNÍ PŘIPOJENÍ K §LG13§ CLOUD ENGINE. VEŠKERÁ DATA JSOU ŠIFROVÁNA TLS 1.3. SYSTÉM NEPOSKYTUJE PRÁVNÍ PORADENSTVÍ, ALE FORENZNÍ DOKUMENTAČNÍ ASISTENCI.
                  </p>
                </div>
              </div>
              <div className="px-8 py-6 border-t border-[#111] flex justify-between items-center">
                <div className="flex gap-4">
                  <button onClick={clearAllData} className="text-[10px] font-black uppercase text-red-900 hover:text-red-500 flex items-center gap-2">
                    <Trash2 size={14}/> Hard Reset (Smazat vše)
                  </button>
                  <button onClick={() => downloadReport('README')} className="text-[10px] font-black uppercase text-[#444] hover:text-white flex items-center gap-2">
                    <Download size={14}/> Stáhnout User Guide (MD)
                  </button>
                  <button onClick={downloadTechnicalReadme} className="text-[10px] font-black uppercase text-[#C5A059] hover:text-white flex items-center gap-2">
                    <FileJson size={14}/> Stáhnout Technickou Dokumentaci (MD)
                  </button>
                </div>
                <div className="text-[8px] font-mono text-[#333]">ENGINE_HASH: 0xLG13_V4_STABLE</div>
              </div>
            </div>
          </motion.div>
        )}

        {isDrivePickerOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-black/90 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-[#151515] border border-[#222] flex flex-col shadow-2xl max-h-[80vh]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#222]">
                <div className="flex items-center gap-4">
                  <div className="px-2 py-1 bg-[#C5A059] text-black text-[9px] font-black uppercase">GOOGLE DRIVE</div>
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-white">LG13_Terminal_Data</h3>
                </div>
                <button onClick={() => setIsDrivePickerOpen(false)} className="text-[#666] hover:text-white transition-colors p-2">
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                {isDrivePickerLoading ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <Loader2 size={32} className="animate-spin text-[#C5A059] opacity-40" />
                    <span className="text-[10px] uppercase font-black tracking-widest text-[#444]">Načítám seznam souborů...</span>
                  </div>
                ) : driveFolderFiles.length === 0 ? (
                  <div className="text-center py-20 text-[#444] text-[10px] uppercase font-black">
                    Složka je prázdná
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {driveFolderFiles.map(df => {
                      const isAlreadyImported = uploadedFiles.some(f => f.driveId === df.id);
                      return (
                        <div key={df.id} className="flex items-center justify-between p-3 border border-[#222] bg-[#111] hover:border-[#444] transition-all group">
                          <div className="flex items-center gap-3 overflow-hidden">
                            <FileText size={16} className={isAlreadyImported ? "text-[#444]" : "text-[#C5A059]"} />
                            <div className="flex flex-col">
                              <span className={cn("text-[11px] font-bold truncate", isAlreadyImported ? "text-[#444]" : "text-white")}>{df.name}</span>
                              <span className="text-[8px] font-mono text-[#444] uppercase">{df.mimeType}</span>
                            </div>
                          </div>
                          <button 
                            onClick={() => importDriveFile(df)}
                            disabled={isAlreadyImported}
                            className={cn(
                              "px-3 py-1 text-[9px] font-black uppercase transition-all",
                              isAlreadyImported ? "text-[#444] border border-[#222] cursor-default" : "bg-[#C5A059] text-black hover:bg-white"
                            )}
                          >
                            {isAlreadyImported ? 'Importováno' : 'Importovat'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              
              <div className="px-6 py-4 bg-[#111] border-t border-[#222] flex justify-between items-center text-[9px] font-mono text-[#444]">
                <span>FOLDER_ID: LG13_Terminal_Data</span>
                <button 
                  onClick={fetchDriveFolderFiles}
                  className="flex items-center gap-2 hover:text-white transition-colors"
                >
                  <RefreshCcw size={10} /> Obnovit
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {previewFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-black/90 backdrop-blur-sm">
            <div className="w-full h-full max-w-5xl bg-[#151515] border border-[#222] flex flex-col shadow-2xl">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#222]">
                <div className="flex items-center gap-4">
                  <div className="px-2 py-1 bg-[#C5A059] text-black text-[9px] font-black uppercase">PREVIEW</div>
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-white">{previewFile.name}</h3>
                </div>
                <button onClick={() => setPreviewFile(null)} className="text-[#666] hover:text-white transition-colors p-2">
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 bg-white relative overflow-hidden">
                <div className="absolute inset-0 flex items-center justify-center text-black font-mono text-xs italic p-12 text-center opacity-30 select-none pointer-events-none">
                  // §LG13§ SECURE PREVIEW SYSTEM // RENDERED IN SANDBOX
                </div>
                {previewFile.type === 'PDF' ? (
                  <iframe src={URL.createObjectURL(new Blob([], { type: 'application/pdf' }))} className="w-full h-full border-none" title="PDF Preview" />
                ) : (
                  <div className="w-full h-full overflow-auto p-12 text-black font-serif italic text-lg leading-relaxed">
                    [Obsah souboru s volnou textovou strukturou]
                  </div>
                )}
              </div>
              <div className="px-6 py-4 bg-[#111] border-t border-[#222] flex justify-between items-center text-[9px] font-mono text-[#444]">
                <span>FILE_ID: {previewFile.id}</span>
                <span>SECURED_WITH_TLS_ENCRYPTION</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Case Creation Modal */}
      <AnimatePresence>
        {showCaseModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm p-6">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#111] border border-[#C5A059] p-8 max-w-md w-full shadow-[0_0_50px_rgba(197,160,89,0.2)]"
            >
              <div className="flex justify-between items-center mb-8 border-b border-[#222] pb-4">
                <h2 className="text-xl font-black uppercase tracking-widest text-[#C5A059]">NOVÝ_SPISOVÝ_ZÁZNAM</h2>
                <button onClick={() => setShowCaseModal(false)} className="text-[#444] hover:text-white"><X size={20}/></button>
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-[#666] tracking-widest">Jednací číslo / ID</label>
                  <input 
                    type="text" 
                    value={newCaseData.nr} 
                    onChange={(e) => setNewCaseData(prev => ({ ...prev, nr: e.target.value }))}
                    className="w-full bg-[#0a0a0a] border border-[#222] p-4 text-white font-mono outline-none focus:border-[#C5A059] transition-all"
                    placeholder="2026/LG/13..."
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-[#666] tracking-widest">Název Spisu</label>
                  <input 
                    type="text" 
                    value={newCaseData.name} 
                    onChange={(e) => setNewCaseData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full bg-[#0a0a0a] border border-[#222] p-4 text-white uppercase font-black outline-none focus:border-[#C5A059] transition-all"
                    placeholder="NÁZEV PŘÍPADU..."
                  />
                </div>
                
                <div className="pt-4 flex flex-col gap-4">
                  <button 
                    onClick={confirmCreateCase}
                    className="w-full py-4 bg-[#C5A059] text-black font-black uppercase tracking-[0.2em] hover:bg-white transition-all flex items-center justify-center gap-2"
                  >
                    <Plus size={16}/> Vytvořit sezení
                  </button>
                  <p className="text-[9px] text-[#444] text-center uppercase leading-relaxed font-black">
                    Vytvořením nového spisu dojde k aktivaci prázdného kontextu a resetu aktuálních výběrů k auditu.
                  </p>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
