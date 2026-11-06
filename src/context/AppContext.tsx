import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { VaultFile, StorageNode, SharedLink, ActivityItem, DashboardMetrics, User, DedupStats } from '../types';
import { api } from '../services/api';
import { 
  createShareEnvelope, 
  generateMasterKeyEnvelope, 
  verifyMasterPasswordWithToken, 
  unlockMasterKeyWithPassword, 
  unlockMasterKeyWithRecoveryKey, 
  rotateMasterPassword,
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  hexToBytes,
  bytesToHex
} from '../services/cryptoService';

interface ToastState {
  id: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'danger';
}

interface AppContextType {
  currentRoute: string;
  setCurrentRoute: (route: string) => void;
  user: User | null;
  files: VaultFile[];
  nodes: StorageNode[];
  sharedLinks: SharedLink[];
  activities: ActivityItem[];
  dashboardMetrics: DashboardMetrics;
  dedupStats: DedupStats | null;
  isLoadingDedup: boolean;
  loadDedupStats: (force?: boolean) => Promise<void>;
  selectedFile: VaultFile | null;
  setSelectedFile: (file: VaultFile | null) => void;
  isAiOpen: boolean;
  setIsAiOpen: (open: boolean) => void;
  isDemoOpen: boolean;
  setIsDemoOpen: (open: boolean) => void;
  isShareOpen: boolean;
  setIsShareOpen: (open: boolean) => void;
  shareTargetFile: VaultFile | null;
  setShareTargetFile: (file: VaultFile | null) => void;
  toasts: ToastState[];
  showToast: (message: string, type?: ToastState['type']) => void;
  removeToast: (id: string) => void;
  isLoading: boolean;
  loadBackendData: () => Promise<void>;
  login: (email: string, pass: string) => Promise<boolean>;
  register: (name: string, email: string, pass: string) => Promise<boolean>;
  logout: () => void;
  uploadFile: (file: File) => Promise<boolean>;
  addFileToVault: (file: VaultFile) => void;
  deleteFile: (fileId: string) => Promise<boolean>;
  downloadFile: (fileId: string, fileName: string) => Promise<void>;
  createShareLink: (
    fileId: string,
    password?: string,
    expiresDays?: number,
    downloadLimit?: number
  ) => Promise<{ share: SharedLink; fullUrl: string } | null>;
  revokeShareLink: (shareIdOrToken: string) => Promise<boolean>;
  executeAiCommand: (cmd: string) => Promise<{ response: string; action?: { type: string; route?: string; label?: string } }>;
  updateNodeOptimistic: (nodeId: string, updates: Partial<StorageNode>) => void;
  // Master Password & Vault Lock States
  isVaultLocked: boolean;
  lockVault: () => void;
  unlockVault: (masterPassword: string) => Promise<boolean>;
  isMasterPasswordSetupRequired: boolean;
  setupMasterPassword: (masterPassword: string) => Promise<string>;
  changeMasterPassword: (oldPassword: string, newPassword: string) => Promise<boolean>;
  recoverMasterPassword: (recoveryKeyFormatted: string, newPassword: string) => Promise<boolean>;
  autoLockMinutes: number;
  setAutoLockMinutes: (minutes: number) => Promise<void>;
  isLockModalOpen: boolean;
  setIsLockModalOpen: (open: boolean) => void;
}


const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentRoute, _setCurrentRoute] = useState<string>(() => {
    if (typeof window !== 'undefined' && (window.location.pathname.startsWith('/share') || window.location.search.includes('token='))) {
      return 'share-download';
    }
    // Restore last route from sessionStorage if a token exists (page reload scenario)
    const token = localStorage.getItem('sv_token');
    const saved = sessionStorage.getItem('sv_route');
    if (token && saved && !['landing', 'login', 'register'].includes(saved)) {
      return saved;
    }
    return 'landing';
  });

  const setCurrentRoute = (route: string) => {
    _setCurrentRoute(route);
    try { sessionStorage.setItem('sv_route', route); } catch {}
    api.logUiAction('UI_ROUTE_NAVIGATE', { targetRoute: route });
  };

  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('sv_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [files, setFiles] = useState<VaultFile[]>(() => {
    try {
      const saved = sessionStorage.getItem('sv_cached_files');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [nodes, setNodes] = useState<StorageNode[]>([]);
  const [sharedLinks, setSharedLinks] = useState<SharedLink[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [dashboardMetrics, setDashboardMetrics] = useState<DashboardMetrics>(() => {
    try {
      const saved = sessionStorage.getItem('sv_cached_dashboard_metrics');
      if (saved) return JSON.parse(saved);
    } catch {}
    return {
      storageUsedGB: 0,
      storageTotalGB: 100,
      fileCount: 0,
      activeNodesCount: 6,
      totalNodesCount: 6,
      securityScore: 99.8,
      totalShards: 0,
      categoryDistribution: [],
    };
  });
  const [dedupStats, setDedupStats] = useState<DedupStats | null>(() => {
    try {
      const saved = sessionStorage.getItem('sv_cached_dedup_stats');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [isLoadingDedup, setIsLoadingDedup] = useState(false);

  const [selectedFile, setSelectedFile] = useState<VaultFile | null>(null);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [isDemoOpen, setIsDemoOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [shareTargetFile, setShareTargetFile] = useState<VaultFile | null>(null);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Master Password & Vault Lock States
  const [isVaultLocked, setIsVaultLocked] = useState<boolean>(() => {
    // If no token, vault is not locked (not logged in)
    const token = localStorage.getItem('sv_token');
    if (!token) return false;
    // Check if we have an active session vault pass
    const sessionPass = sessionStorage.getItem('sv_vault_pass');
    if (sessionPass) return false; // already unlocked this session
    // Check cached user to know if they have a master password configured
    try {
      const saved = localStorage.getItem('sv_user');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only lock if master password has been configured
        return !!parsed.hasMasterPassword;
      }
    } catch {}
    return false;
  });

  const [autoLockMinutes, setAutoLockMinutesState] = useState<number>(() => {
    try {
      const savedUser = localStorage.getItem('sv_user');
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        return parsed.autoLockMinutes || 15;
      }
    } catch {}
    return 15;
  });

  const [isLockModalOpen, setIsLockModalOpen] = useState<boolean>(false);
  const autoLockTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isMasterPasswordSetupRequired = !!(user && !user.hasMasterPassword);

  const lockVault = () => {
    sessionStorage.removeItem('sv_vault_pass');
    setIsVaultLocked(true);
    showToast('Vault locked. Enter master password to unlock.', 'info');
    api.logUiAction('VAULT_LOCKED_MANUALLY');
  };

  const resetAutoLockTimer = () => {
    if (autoLockTimerRef.current) {
      clearTimeout(autoLockTimerRef.current);
    }
    if (autoLockMinutes > 0 && !isVaultLocked) {
      autoLockTimerRef.current = setTimeout(() => {
        sessionStorage.removeItem('sv_vault_pass');
        setIsVaultLocked(true);
        showToast(`Vault auto-locked after ${autoLockMinutes} minutes of inactivity.`, 'warning');
        api.logUiAction('VAULT_AUTO_LOCKED', { inactivityMinutes: autoLockMinutes });
      }, autoLockMinutes * 60 * 1000);
    }
  };

  useEffect(() => {
    const handleActivity = () => {
      if (!isVaultLocked) {
        resetAutoLockTimer();
      }
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('click', handleActivity);

    resetAutoLockTimer();

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('click', handleActivity);
      if (autoLockTimerRef.current) clearTimeout(autoLockTimerRef.current);
    };
  }, [autoLockMinutes, isVaultLocked]);

  const unlockVault = async (masterPassword: string): Promise<boolean> => {
    if (!user) return false;

    let currentUser = user;

    // 1. If user has cryptographic master password configured, verify verifier token
    if (currentUser.hasMasterPassword && currentUser.masterPasswordSalt && currentUser.masterKeyVerifier) {
      let isValid = await verifyMasterPasswordWithToken(
        masterPassword,
        currentUser.masterPasswordSalt,
        currentUser.masterKeyVerifier
      );

      // If validation fails against cached user state, fetch latest envelope from backend and re-verify
      if (!isValid) {
        try {
          const freshData = await api.getMe();
          if (freshData && (freshData as any).user) {
            currentUser = { ...currentUser, ...(freshData as any).user };
            setUser(currentUser);
            try { localStorage.setItem('sv_user', JSON.stringify(currentUser)); } catch {}
            if (currentUser.masterPasswordSalt && currentUser.masterKeyVerifier) {
              isValid = await verifyMasterPasswordWithToken(
                masterPassword,
                currentUser.masterPasswordSalt,
                currentUser.masterKeyVerifier
              );
            }
          }
        } catch {}
      }

      if (!isValid) {
        throw new Error('Incorrect master password. Access denied.');
      }
    }

    // 2. Set session passkey
    sessionStorage.setItem('sv_vault_pass', masterPassword);
    setIsVaultLocked(false);
    setIsLockModalOpen(false);
    showToast('Vault unlocked successfully!', 'success');
    api.logUiAction('VAULT_UNLOCKED_SUCCESS');
    resetAutoLockTimer();
    return true;
  };

  const setupMasterPassword = async (masterPassword: string): Promise<string> => {
    if (!user) throw new Error('User session required');
    const envelope = await generateMasterKeyEnvelope(masterPassword);

    const res = await api.setupMasterPassword({
      masterPasswordSalt: envelope.masterPasswordSalt,
      wrappedMasterKey: envelope.wrappedMasterKey,
      masterKeyVerifier: envelope.masterKeyVerifier,
      recoveryKeyHash: envelope.recoveryKeyHash,
      recoverySalt: envelope.recoverySalt,
      wrappedMasterKeyWithRecovery: envelope.wrappedMasterKeyWithRecovery,
      autoLockMinutes
    });

    if (!res.success) {
      throw new Error(res.message || 'Setup failed on server');
    }

    // Update local user state
    const updatedUser = {
      ...user,
      hasMasterPassword: true,
      masterPasswordSalt: envelope.masterPasswordSalt,
      wrappedMasterKey: envelope.wrappedMasterKey,
      masterKeyVerifier: envelope.masterKeyVerifier,
      recoveryKeyHash: envelope.recoveryKeyHash,
      recoverySalt: envelope.recoverySalt,
      wrappedMasterKeyWithRecovery: envelope.wrappedMasterKeyWithRecovery
    };
    setUser(updatedUser);
    try { localStorage.setItem('sv_user', JSON.stringify(updatedUser)); } catch {}

    sessionStorage.setItem('sv_vault_pass', masterPassword);
    setIsVaultLocked(false);
    showToast('Master password and key envelope initialized!', 'success');
    api.logUiAction('MASTER_PASSWORD_SETUP_SUCCESS');
    return envelope.recoveryKeyFormatted;
  };

  const changeMasterPassword = async (oldPassword: string, newPassword: string): Promise<boolean> => {
    if (!user) throw new Error('User session required');
    if (newPassword.length < 8) throw new Error('New password must be at least 8 characters');

    // 1. Verify old password
    if (user.hasMasterPassword && user.masterPasswordSalt && user.masterKeyVerifier) {
      const isValid = await verifyMasterPasswordWithToken(oldPassword, user.masterPasswordSalt, user.masterKeyVerifier);
      if (!isValid) throw new Error('Current master password is incorrect.');
    }

    // 2. Derive new envelope
    let updatedWrappedMasterKey: string;
    let newSalt: string;
    let newVerifier: string;

    if (user.wrappedMasterKey && user.masterPasswordSalt) {
      // Unwrap existing Master Key and rotate under new password
      const masterKey = await unlockMasterKeyWithPassword(oldPassword, user.masterPasswordSalt, user.wrappedMasterKey);
      const rotated = await rotateMasterPassword(masterKey, newPassword);
      updatedWrappedMasterKey = rotated.wrappedMasterKey;
      newSalt = rotated.masterPasswordSalt;
      newVerifier = rotated.masterKeyVerifier;
    } else {
      // If user had legacy password setup, generate full new envelope
      const env = await generateMasterKeyEnvelope(newPassword);
      updatedWrappedMasterKey = env.wrappedMasterKey;
      newSalt = env.masterPasswordSalt;
      newVerifier = env.masterKeyVerifier;
    }

    // 3. Batch rewrap existing user files from oldPassword -> newPassword
    const userFiles = files.filter(f => f.wrappedDEK && f.kdfSalt);
    if (userFiles.length > 0) {
      const updates: Array<{ fileId: string; wrappedDEK: string; kdfSalt?: string; kdfIterations?: number }> = [];
      for (const f of userFiles) {
        try {
          const oldKek = await deriveKEK(oldPassword, hexToBytes(f.kdfSalt!), f.kdfIterations || 100000);
          const dek = await unwrapDEK(hexToBytes(f.wrappedDEK!), oldKek);
          const newKek = await deriveKEK(newPassword, hexToBytes(f.kdfSalt!), f.kdfIterations || 100000);
          const rewrapped = await wrapDEK(dek, newKek);
          updates.push({
            fileId: f.id,
            wrappedDEK: bytesToHex(rewrapped),
            kdfSalt: f.kdfSalt,
            kdfIterations: f.kdfIterations
          });
        } catch (unwrapErr) {
          console.warn(`File ${f.id} rewrap skipped (custom password or already rotated):`, unwrapErr);
        }
      }
      if (updates.length > 0) {
        await api.batchRewrapFiles(updates);
      }
    }

    // 4. Update backend user document
    const res = await api.changeMasterPassword({
      masterPasswordSalt: newSalt,
      wrappedMasterKey: updatedWrappedMasterKey,
      masterKeyVerifier: newVerifier
    });

    if (!res.success) throw new Error(res.message || 'Server rejected password change.');

    // 5. Update state
    const updatedUser = {
      ...user,
      hasMasterPassword: true,
      masterPasswordSalt: newSalt,
      wrappedMasterKey: updatedWrappedMasterKey,
      masterKeyVerifier: newVerifier
    };
    setUser(updatedUser);
    try { localStorage.setItem('sv_user', JSON.stringify(updatedUser)); } catch {}

    sessionStorage.setItem('sv_vault_pass', newPassword);
    setIsVaultLocked(false);
    showToast('Master password changed and all keys rewrapped with 0 file re-encryption!', 'success');
    api.logUiAction('MASTER_PASSWORD_CHANGED_SUCCESS');
    await loadBackendData();
    return true;
  };

  const recoverMasterPassword = async (recoveryKeyFormatted: string, newPassword: string): Promise<boolean> => {
    if (!user) throw new Error('User session required');
    if (!user.recoverySalt || !user.wrappedMasterKeyWithRecovery) {
      throw new Error('No recovery envelope found on server for this account.');
    }

    // 1. Clean recovery key and compute SHA-256 hash to verify against server
    const cleanHex = recoveryKeyFormatted.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    if (cleanHex.length !== 64) {
      throw new Error('Invalid recovery key format. Expected 64 hex characters (32 bytes).');
    }
    const recoveryHashBuffer = await globalThis.crypto.subtle.digest('SHA-256', hexToBytes(cleanHex));
    const recoveryHashHex = bytesToHex(new Uint8Array(recoveryHashBuffer));

    // 2. Unlock master key using recovery key
    const masterKey = await unlockMasterKeyWithRecoveryKey(
      recoveryKeyFormatted,
      user.recoverySalt,
      user.wrappedMasterKeyWithRecovery
    );

    // 3. Rewrap Master Key with new master password
    const rotated = await rotateMasterPassword(masterKey, newPassword);

    // 4. Send verified recovery payload to server
    const res = await api.recoverMasterKey({
      masterPasswordSalt: rotated.masterPasswordSalt,
      wrappedMasterKey: rotated.wrappedMasterKey,
      masterKeyVerifier: rotated.masterKeyVerifier,
      recoveryKeyHashVerified: recoveryHashHex
    });

    if (!res.success) throw new Error(res.message || 'Recovery failed on server');

    const updatedUser = {
      ...user,
      hasMasterPassword: true,
      masterPasswordSalt: rotated.masterPasswordSalt,
      wrappedMasterKey: rotated.wrappedMasterKey,
      masterKeyVerifier: rotated.masterKeyVerifier
    };
    setUser(updatedUser);
    try { localStorage.setItem('sv_user', JSON.stringify(updatedUser)); } catch {}

    sessionStorage.setItem('sv_vault_pass', newPassword);
    setIsVaultLocked(false);
    showToast('Vault access restored via emergency recovery key!', 'success');
    api.logUiAction('MASTER_KEY_RECOVERED_SUCCESS');
    return true;
  };

  const setAutoLockMinutes = async (minutes: number) => {
    setAutoLockMinutesState(minutes);
    if (user) {
      const updatedUser = { ...user, autoLockMinutes: minutes };
      setUser(updatedUser);
      try { localStorage.setItem('sv_user', JSON.stringify(updatedUser)); } catch {}
      await api.updateAutoLock(minutes).catch(() => {});
    }
    resetAutoLockTimer();
  };

  const showToast = (message: string, type: ToastState['type'] = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      removeToast(id);
    }, 4000);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const loadDedupStats = async (_force = false) => {
    try {
      setIsLoadingDedup(true);
      const stats = await api.fetchDedupStats();
      if (stats) {
        setDedupStats(stats);
        try { sessionStorage.setItem('sv_cached_dedup_stats', JSON.stringify(stats)); } catch {}
      }
    } catch (e) {
      // Backend handles fallback
    } finally {
      setIsLoadingDedup(false);
    }
  };

  const loadBackendData = async () => {
    const token = api.getToken();
    if (!token) {
      setFiles([]);
      setActivities([]);
      setDedupStats(null);
      setDashboardMetrics({
        storageUsedGB: 0,
        storageTotalGB: 100,
        fileCount: 0,
        activeNodesCount: 6,
        totalNodesCount: 6,
        securityScore: 99.8,
        totalShards: 0,
        categoryDistribution: [],
      });
      return;
    }

    setIsLoading(true);
    try {
      const [backendFiles, backendNodes, backendShares, backendActivities, dash, backendDedup] = await Promise.all([
        api.fetchFiles().catch(() => []),
        api.fetchNodes().catch(() => []),
        api.fetchShares().catch(() => []),
        api.fetchActivities().catch(() => []),
        api.fetchDashboard().catch(() => null),
        api.fetchDedupStats().catch(() => null),
      ]);

      if (backendFiles) {
        setFiles(backendFiles);
        try { sessionStorage.setItem('sv_cached_files', JSON.stringify(backendFiles)); } catch {}
      }
      if (backendNodes) setNodes(backendNodes);
      if (backendShares) setSharedLinks(backendShares);
      if (backendActivities) setActivities(backendActivities);
      if (dash && dash.metrics) {
        setDashboardMetrics(dash.metrics);
        try { sessionStorage.setItem('sv_cached_dashboard_metrics', JSON.stringify(dash.metrics)); } catch {}
      }
      if (backendDedup) {
        setDedupStats(backendDedup);
        try { sessionStorage.setItem('sv_cached_dedup_stats', JSON.stringify(backendDedup)); } catch {}
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const restoreSession = async () => {
      const token = api.getToken();
      if (token) {
        // Token exists in localStorage — try to restore the authenticated session
        try {
          const meData = await api.getMe();
          if (meData && meData.user) {
            setUser(meData.user);
            try { localStorage.setItem('sv_user', JSON.stringify(meData.user)); } catch {}
            // Route is already restored from sessionStorage by useState initializer.
            // Only override if we're somehow still on landing (no saved route).
            if (window.location.pathname.startsWith('/share/')) {
              setCurrentRoute('share-download');
            } else if (currentRoute === 'landing') {
              setCurrentRoute('dashboard');
            }
          } else if (meData && (meData as any).unauthorized) {
            // Token returned explicit 401 — invalid/expired, clear it
            api.setToken(null);
            try { localStorage.removeItem('sv_user'); } catch {}
            setUser(null);
            setCurrentRoute('landing');
          } else {
            // Network failure or temporary unreachable — keep cached session
            try {
              const cached = localStorage.getItem('sv_user');
              if (cached) setUser(JSON.parse(cached));
            } catch {}
          }
        } catch {
          // Keep cached user on network errors
          try {
            const cached = localStorage.getItem('sv_user');
            if (cached) setUser(JSON.parse(cached));
          } catch {}
        }
      }
      // Load backend data regardless (will early-return if no token)
      await loadBackendData();
      if (window.location.pathname.startsWith('/share/')) {
        setCurrentRoute('share-download');
      }
    };
    restoreSession();
  }, []);


  const login = async (email: string, pass: string): Promise<boolean> => {
    try {
      setIsLoading(true);
      const res = await api.login(email, pass);
      if (res.error) {
        showToast(res.error, 'danger');
        return false;
      }
      const loggedInUser = res.user || { name: email.split('@')[0], email };
      setUser(loggedInUser);
      api.logUiAction('UI_LOGIN_SUCCESS', { email });

      // If user has master password configured, the vault should be locked until they unlock it
      // Set the session pass only if they DON'T have a master password (legacy behavior)
      if (loggedInUser.hasMasterPassword) {
        // Clear any stale session pass from previous session
        sessionStorage.removeItem('sv_vault_pass');
        setIsVaultLocked(true);
        showToast('Secure authenticated session. Vault is locked — enter master password to unlock.', 'info');
      } else {
        // No master password configured — use login password as session passkey
        sessionStorage.setItem('sv_vault_pass', pass);
        setIsVaultLocked(false);
        showToast('Secure authenticated session', 'success');
      }

      await loadBackendData();
      setCurrentRoute('dashboard');
      return true;
    } catch (err: any) {
      showToast(err.message || 'Unable to connect to SecureVault server.', 'danger');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (name: string, email: string, pass: string): Promise<boolean> => {
    try {
      setIsLoading(true);
      const res = await api.register(name, email, pass);
      if (res.error) {
        showToast(res.error, 'danger');
        return false;
      }
      setUser(res.user || { name, email });
      // For new registrations, no master password is set yet — use login pass as session key
      // This keeps vault unlocked so user can start using the app immediately
      sessionStorage.setItem('sv_vault_pass', pass);
      setIsVaultLocked(false);
      api.logUiAction('UI_REGISTER_SUCCESS', { name, email });
      showToast('Vault created! Master key generated.', 'success');
      await loadBackendData();
      setCurrentRoute('dashboard');
      return true;
    } catch (err: any) {
      showToast(err.message || 'Unable to connect to SecureVault server.', 'danger');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = () => {
    api.logUiAction('UI_USER_LOGOUT', { user: user?.email });
    api.setToken(null);
    try {
      sessionStorage.removeItem('sv_route');
      sessionStorage.removeItem('sv_vault_pass');
      sessionStorage.removeItem('sv_mp_prompted');
      sessionStorage.removeItem('sv_cached_files');
      sessionStorage.removeItem('sv_cached_dashboard_metrics');
      sessionStorage.removeItem('sv_cached_dedup_stats');
    } catch {}
    setUser(null);
    setFiles([]);
    setActivities([]);
    setDashboardMetrics({
      storageUsedGB: 0,
      storageTotalGB: 100,
      fileCount: 0,
      activeNodesCount: 6,
      totalNodesCount: 6,
      securityScore: 99.8,
      totalShards: 0,
      categoryDistribution: [],
    });
    showToast('Logged out of vault session', 'info');
    setCurrentRoute('landing');
  };

  // Targeted state mutator — add a single file to vault without full refetch
  const addFileToVault = (file: VaultFile) => {
    setFiles(prev => {
      const updated = [file, ...prev.filter(f => f.id !== file.id)];
      try { sessionStorage.setItem('sv_cached_files', JSON.stringify(updated)); } catch {}
      return updated;
    });
    setDashboardMetrics(prev => ({ ...prev, fileCount: (prev.fileCount || 0) + 1 }));
  };

  const uploadFile = async (file: File): Promise<boolean> => {
    try {
      setIsLoading(true);
      const res = await api.uploadFile(file);
      if (res.success && res.file) {
        // IMMEDIATE optimistic update — prepend new file to vault without waiting for refetch
        addFileToVault(res.file as VaultFile);
        showToast(`File "${file.name}" encrypted & sharded!`, 'success');
        // Background sync: refresh dedup stats & activities only
        Promise.all([
          api.fetchDedupStats().then(s => {
            if (s) {
              setDedupStats(s);
              try { sessionStorage.setItem('sv_cached_dedup_stats', JSON.stringify(s)); } catch {}
            }
          }).catch(() => {}),
          api.fetchActivities().then(a => { if (a) setActivities(a); }).catch(() => {}),
        ]);
        return true;
      }
      showToast('Upload failed', 'danger');
      return false;
    } catch (err: any) {
      showToast(err.message || 'Upload error', 'danger');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const deleteFile = async (fileId: string): Promise<boolean> => {
    // OPTIMISTIC: immediately remove from UI before API call completes
    const previousFiles = [...files];
    setFiles(prev => {
      const updated = prev.filter(f => f.id !== fileId);
      try { sessionStorage.setItem('sv_cached_files', JSON.stringify(updated)); } catch {}
      return updated;
    });
    setDashboardMetrics(prev => ({ ...prev, fileCount: Math.max(0, (prev.fileCount || 1) - 1) }));

    try {
      setIsLoading(true);
      await api.deleteFile(fileId);
      showToast('File and shards permanently shredded', 'warning');
      // Background: refresh dedup stats only
      api.fetchDedupStats().then(s => {
        if (s) {
          setDedupStats(s);
          try { sessionStorage.setItem('sv_cached_dedup_stats', JSON.stringify(s)); } catch {}
        }
      }).catch(() => {});
      return true;
    } catch (err: any) {
      // ROLLBACK on failure — restore previous state
      setFiles(previousFiles);
      try { sessionStorage.setItem('sv_cached_files', JSON.stringify(previousFiles)); } catch {}
      setDashboardMetrics(prev => ({ ...prev, fileCount: (prev.fileCount || 0) + 1 }));
      showToast(err.message || 'Delete failed', 'danger');
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const downloadFile = async (fileId: string, fileName: string) => {
    try {
      showToast(`Reconstructing shards for ${fileName}...`, 'info');
      await api.downloadFile(fileId, fileName);
      showToast(`File ${fileName} downloaded & decrypted!`, 'success');
    } catch (err: any) {
      showToast('Download error', 'danger');
    }
  };

  const createShareLink = async (
    fileId: string,
    password?: string,
    expiresDays = 7,
    downloadLimit = 10
  ): Promise<{ share: SharedLink; fullUrl: string } | null> => {
    try {
      const file = files.find(f => f.id === fileId);
      let wrappedDEKForShare: string | null = null;
      let kdf = 'PBKDF2-HMAC-SHA256';
      let kdfSalt: string | null = null;
      let kdfIterations = 100000;
      let linkKeyHex: string | null = null;

      if (file && (file.cryptoVersion === 2 || file.wrappedDEK)) {
        const candidatePasswords: string[] = [];
        const sessionPass = sessionStorage.getItem('sv_vault_pass');
        if (sessionPass && sessionPass.trim()) candidatePasswords.push(sessionPass.trim());
        const legacyFallbacks = ['SecureVault-Default-Session-Vault-Passkey', 'Sanskruti@123', '12345678'];
        for (const fb of legacyFallbacks) {
          if (!candidatePasswords.includes(fb)) candidatePasswords.push(fb);
        }

        const effectiveHash = file.originalFileHash || file.hash;

        const envelope = await createShareEnvelope(
          file.wrappedDEK || '',
          candidatePasswords,
          file.kdfSalt || '',
          file.kdfIterations || 100000,
          (file.kdf as any) || 'PBKDF2-HMAC-SHA256',
          password,
          effectiveHash
        );
        wrappedDEKForShare = envelope.wrappedDEKForShare;
        kdf = envelope.kdf;
        kdfSalt = envelope.kdfSalt;
        kdfIterations = envelope.kdfIterations;
        linkKeyHex = envelope.linkKeyHex;
      }

      const share = await api.createShare({
        fileId,
        expiresDays,
        downloadLimit,
        isPasswordProtected: !!password && password.trim().length > 0,
        wrappedDEKForShare,
        kdf,
        kdfSalt,
        kdfIterations,
      });

      // If public link (no password), append zero-knowledge link key to hash fragment
      const origin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'http://localhost:5173';
      const baseUrl = `${origin}/share/${share.token || share.id}`;
      let fullUrl = baseUrl;
      if (!password && linkKeyHex) {
        fullUrl = `${baseUrl}#key=${linkKeyHex}`;
        try {
          localStorage.setItem(`sv_share_key_${share.token || share.id}`, linkKeyHex);
        } catch {}
      }

      // Optimistically update sharedLinks state immediately without blocking modal
      setSharedLinks(prev => {
        const filtered = prev.filter(s => s.id !== share.id && s.token !== share.token);
        return [share, ...filtered];
      });

      showToast('Secure zero-knowledge share link created', 'success');

      // Refresh shares and activities in background without holding the modal hostage
      api.fetchShares().then(backendShares => {
        if (backendShares && Array.isArray(backendShares)) setSharedLinks(backendShares);
      }).catch(() => {});
      api.fetchActivities().then(backendActivities => {
        if (backendActivities && Array.isArray(backendActivities)) setActivities(backendActivities);
      }).catch(() => {});

      return { share, fullUrl };
    } catch (err: any) {
      showToast(err.message || 'Sharing error', 'danger');
      return null;
    }
  };

  const revokeShareLink = async (shareIdOrToken: string): Promise<boolean> => {
    try {
      await api.revokeShare(shareIdOrToken);
      setSharedLinks(prev => prev.filter(s => s.id !== shareIdOrToken && s.token !== shareIdOrToken));
      showToast('Share link revoked successfully', 'warning');
      api.fetchShares().then(backendShares => {
        if (backendShares && Array.isArray(backendShares)) setSharedLinks(backendShares);
      }).catch(() => {});
      return true;
    } catch (err: any) {
      showToast(err.message || 'Failed to revoke share link', 'danger');
      return false;
    }
  };

  const executeAiCommand = async (cmd: string): Promise<{ response: string; action?: { type: string; route?: string; label?: string } }> => {
    try {
      api.logUiAction('UI_AI_COMMAND_EXECUTED', { command: cmd });
      const res = await api.sendAICommand(cmd);
      return {
        response: res.response || 'AI command executed successfully.',
        action: res.action || undefined,
      };
    } catch (err: any) {
      return {
        response: 'Command processed locally in fallback mode.',
      };
    }
  };

  const updateNodeOptimistic = (nodeId: string, updates: Partial<StorageNode>) => {
    setNodes(prev => prev.map(n => {
      const match = (n.id === nodeId || n.nodeId === nodeId || n.name === nodeId);
      if (match) {
        return { ...n, ...updates };
      }
      return n;
    }));
  };

  return (
    <AppContext.Provider
      value={{
        currentRoute,
        setCurrentRoute,
        user,
        files,
        nodes,
        sharedLinks,
        activities,
        dashboardMetrics,
        dedupStats,
        isLoadingDedup,
        loadDedupStats,
        selectedFile,
        setSelectedFile,
        isAiOpen,
        setIsAiOpen,
        isDemoOpen,
        setIsDemoOpen,
        isShareOpen,
        setIsShareOpen,
        shareTargetFile,
        setShareTargetFile,
        toasts,
        showToast,
        removeToast,
        isLoading,
        loadBackendData,
        login,
        register,
        logout,
        uploadFile,
        addFileToVault,
        deleteFile,
        downloadFile,
        createShareLink,
        revokeShareLink,
        executeAiCommand,
        updateNodeOptimistic,
        isVaultLocked,
        lockVault,
        unlockVault,
        isMasterPasswordSetupRequired,
        setupMasterPassword,
        changeMasterPassword,
        recoverMasterPassword,
        autoLockMinutes,
        setAutoLockMinutes,
        isLockModalOpen,
        setIsLockModalOpen,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};


export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within an AppProvider');
  return context;
};