import React, { useEffect } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Canvas3D } from './scene/Canvas3D';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';
import { AICommandCenter } from './components/AICommandCenter';
import { InteractiveDemoModal } from './components/InteractiveDemoModal';
import { ShareModal } from './components/ShareModal';
import { VaultLockModal } from './components/VaultLockModal';
import { Toast } from './components/Toast';

import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { UploadPage } from './pages/UploadPage';
import { VaultPage } from './pages/VaultPage';
import { FileDetailsPage } from './pages/FileDetailsPage';
import { SecurityPage } from './pages/SecurityPage';
import { NodeMonitorPage } from './pages/NodeMonitorPage';
import { SettingsPage } from './pages/SettingsPage';
import { DownloadRecoveryPage } from './pages/DownloadRecoveryPage';
import { ShardViewerPage } from './pages/ShardViewerPage';
import { SharedFilesPage } from './pages/SharedFilesPage';
import { ShareDownloadPage } from './pages/ShareDownloadPage';
import { ActivityPage } from './pages/ActivityPage';

const MainLayout: React.FC = () => {
  const {
    currentRoute,
    isLockModalOpen,
    setIsLockModalOpen,
    isMasterPasswordSetupRequired,
    user,
  } = useApp();

  const showSidebar = !['landing', 'login', 'register', 'share-download', 'share'].includes(currentRoute);

  // Prompt first-time master password setup once per session (after login)
  useEffect(() => {
    const isProtectedRoute = !['landing', 'login', 'register', 'share-download', 'share'].includes(currentRoute);
    if (user && isProtectedRoute && isMasterPasswordSetupRequired) {
      const alreadyPrompted = sessionStorage.getItem('sv_mp_prompted');
      if (!alreadyPrompted) {
        sessionStorage.setItem('sv_mp_prompted', '1');
        setTimeout(() => setIsLockModalOpen(true), 700);
      }
    }
  }, [user, currentRoute, isMasterPasswordSetupRequired]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderPage = () => {
    switch (currentRoute) {
      case 'landing': return <LandingPage />;
      case 'login': return <LoginPage />;
      case 'register': return <RegisterPage />;
      case 'dashboard': return <DashboardPage />;
      case 'upload': return <UploadPage />;
      case 'vault': return <VaultPage />;
      case 'file-details': return <FileDetailsPage />;
      case 'shared':
      case 'shares': return <SharedFilesPage />;
      case 'share-download':
      case 'share': return <ShareDownloadPage />;
      case 'security': return <SecurityPage />;
      case 'nodes': return <NodeMonitorPage />;
      case 'settings': return <SettingsPage />;
      case 'download': return <DownloadRecoveryPage />;
      case 'shards': return <ShardViewerPage />;
      case 'activity': return <ActivityPage />;
      default: return <LandingPage />;
    }
  };

  return (
    <div className="min-h-screen bg-[#070c18] text-slate-100 relative flex flex-col font-sans overflow-x-hidden">
      <Canvas3D />
      <Navbar />

      <div className="flex flex-1 pt-16 relative z-10">
        {showSidebar && <Sidebar />}
        <main className={`flex-1 transition-all duration-300 ${showSidebar ? 'md:ml-64' : ''} p-4 md:p-8 max-w-7xl mx-auto w-full`}>
          {renderPage()}
        </main>
      </div>

      <AICommandCenter />
      <InteractiveDemoModal />
      <ShareModal />
      <VaultLockModal isOpen={isLockModalOpen} onClose={() => setIsLockModalOpen(false)} />
      <Toast />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <AppProvider>
      <MainLayout />
    </AppProvider>
  );
};

export default App;
