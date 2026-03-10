import SubscribedApp from "./_pages/SubscribedApp"
import {
  QueryClient,
  QueryClientProvider
} from "@tanstack/react-query"
import { useEffect, useState, useCallback, useRef } from "react"
import {
  Toast,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "./components/ui/toast"
import { ToastContext } from "./contexts/toast"
import { AccountDashboardDialog } from "./components/Account/AccountDashboardDialog"
import { AuthScreen } from "./components/Auth/AuthScreen"
import { SettingsDialog } from "./components/Settings/SettingsDialog"
import UninstallOffboardingDialog from "./components/Uninstall/UninstallOffboardingDialog"
import type { AuthState } from "../shared/backendAuth"
import {
  EMPTY_DESKTOP_UPDATE_STATE,
  type DesktopUpdateState,
} from "../shared/desktopUpdates"
import { updateWindowToElement } from "./utils/contentSize"

// Create a React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: Infinity,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 1
    }
  }
})

// Root component that provides the QueryClient
function App() {
  const [toastState, setToastState] = useState({
    open: false,
    title: "",
    description: "",
    variant: "neutral" as "neutral" | "success" | "error"
  })
  const [credits, setCredits] = useState<number>(999) // Unlimited credits
  const [currentLanguage, setCurrentLanguage] = useState<string>("python")
  const [isInitialized, setIsInitialized] = useState(false)
  const [authState, setAuthState] = useState<AuthState>({
    authenticated: false,
    session: null
  })
  // Note: Model selection is now handled via separate extraction/solution/debugging model settings
	
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isAccountDashboardOpen, setIsAccountDashboardOpen] = useState(false)
  const [isUninstallOffboardingOpen, setIsUninstallOffboardingOpen] =
    useState(false)
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(
    EMPTY_DESKTOP_UPDATE_STATE
  )
  const appShellRef = useRef<HTMLDivElement>(null)

  // Set unlimited credits
  const updateCredits = useCallback(() => {
    setCredits(999) // No credit limit in this version
    window.__CREDITS__ = 999
  }, [])

  // Helper function to safely update language
  const updateLanguage = useCallback((newLanguage: string) => {
    setCurrentLanguage(newLanguage)
    window.__LANGUAGE__ = newLanguage
  }, [])

  // Helper function to mark initialization complete
  const markInitialized = useCallback(() => {
    setIsInitialized(true)
    window.__IS_INITIALIZED__ = true
  }, [])

  // Show toast method
  const showToast = useCallback(
    (
      title: string,
      description: string,
      variant: "neutral" | "success" | "error"
    ) => {
      setToastState({
        open: true,
        title,
        description,
        variant
      })
    },
    []
  )

  // Initialize dropdown handler
  useEffect(() => {
    if (isInitialized) {
      // Process all types of dropdown elements with a shorter delay
      const timer = setTimeout(() => {
        // Find both native select elements and custom dropdowns
        const selectElements = document.querySelectorAll('select');
        const customDropdowns = document.querySelectorAll('.dropdown-trigger, [role="combobox"], button:has(.dropdown)');
        
        // Enable native selects
        selectElements.forEach(dropdown => {
          dropdown.disabled = false;
        });
        
        // Enable custom dropdowns by removing any disabled attributes
        customDropdowns.forEach(dropdown => {
          if (dropdown instanceof HTMLElement) {
            dropdown.removeAttribute('disabled');
            dropdown.setAttribute('aria-disabled', 'false');
          }
        });
        
        console.log(`Enabled ${selectElements.length} select elements and ${customDropdowns.length} custom dropdowns`);
      }, 1000);
      
      return () => clearTimeout(timer);
    }
  }, [isInitialized]);

  // Listen for settings dialog open requests
  useEffect(() => {
    const unsubscribeSettings = window.electronAPI.onShowSettings(() => {
      console.log("Show settings dialog requested");
      setIsSettingsOpen(true);
    });
    
    return () => {
      unsubscribeSettings();
    };
  }, []);

  useEffect(() => {
    const handleOpenAccountDashboard = () => {
      setIsAccountDashboardOpen(true)
    }

    window.addEventListener("open-account-dashboard", handleOpenAccountDashboard)
    return () => {
      window.removeEventListener(
        "open-account-dashboard",
        handleOpenAccountDashboard
      )
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onSubscriptionUpdated(() => {
      void window.electronAPI
        .getAuthState()
        .then((nextAuthState) => {
          setAuthState(nextAuthState)
        })
        .catch((error) => {
          console.error("Failed to refresh auth state after billing return:", error)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    void window.electronAPI.getUpdateState().then((result) => {
      if (!cancelled && result.success) {
        setDesktopUpdateState(result.data.state)
      }
    })

    const unsubscribe = window.electronAPI.onUpdateState((state) => {
      setDesktopUpdateState(state)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onShowUninstallOffboarding(() => {
      setIsUninstallOffboardingOpen(true)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  const handleDownloadUpdate = useCallback(async () => {
    return window.electronAPI.downloadUpdate()
  }, [])

  const handleInstallUpdate = useCallback(async () => {
    return window.electronAPI.installUpdate()
  }, [])

  // Initialize basic app state
  useEffect(() => {
    // Load config and set values
    const initializeApp = async () => {
      try {
        // Set unlimited credits
        updateCredits()
        
        // Load config including language and model settings
        const [config, nextAuthState] = await Promise.all([
          window.electronAPI.getConfig(),
          window.electronAPI.getAuthState()
        ])
        
        // Load language preference
        if (config && config.language) {
          updateLanguage(config.language)
        } else {
          updateLanguage("python")
        }

        setAuthState(nextAuthState)
        
        // Model settings are now managed through the settings dialog
        // and stored in config as extractionModel, solutionModel, and debuggingModel
        
        markInitialized()
      } catch (error) {
        console.error("Failed to initialize app:", error)
        // Fallback to defaults
        updateLanguage("python")
        setAuthState({
          authenticated: false,
          session: null,
          error:
            error instanceof Error ? error.message : "Failed to initialize authentication."
        })
        markInitialized()
      }
    }
    
    initializeApp()

    // Event listeners for process events
    const onApiKeyInvalid = () => {
      showToast(
        "Provider Not Ready",
        "The selected provider is not configured, the key is invalid, or it is out of credits.",
        "error"
      )
      setIsSettingsOpen(true)
    }

    const onUnauthorized = () => {
      setAuthState({
        authenticated: false,
        session: null,
        error: "Please log in before using Sylica AI."
      })
      setIsAccountDashboardOpen(false)
      showToast("Login Required", "Please log in to continue.", "error")
    }

    // Setup API key invalid listener
    const unsubscribeApiKeyInvalid = window.electronAPI.onApiKeyInvalid(
      onApiKeyInvalid
    )
    const unsubscribeUnauthorized = window.electronAPI.onUnauthorized(
      onUnauthorized
    )

    // Define a no-op handler for solution success
    const unsubscribeSolutionSuccess = window.electronAPI.onSolutionSuccess(
      () => {
        console.log("Solution success - no credits deducted in this version")
        // No credit deduction in this version
      }
    )

    // Cleanup function
    return () => {
      unsubscribeApiKeyInvalid()
      unsubscribeUnauthorized()
      unsubscribeSolutionSuccess()
      window.__IS_INITIALIZED__ = false
      setIsInitialized(false)
    }
  }, [updateCredits, updateLanguage, markInitialized, showToast])

  const handleAuthenticated = useCallback((nextAuthState: AuthState) => {
    setAuthState(nextAuthState)
  }, [])

  const handleCloseSettings = useCallback((open: boolean) => {
    console.log('Settings dialog state changed:', open);
    setIsSettingsOpen(open);
  }, []);

  const handleCloseAccountDashboard = useCallback((open: boolean) => {
    setIsAccountDashboardOpen(open)
  }, [])

  useEffect(() => {
    if (
      !isInitialized ||
      !authState.authenticated ||
      !appShellRef.current
    ) {
      return
    }

    const timer = window.setTimeout(() => {
      if (!appShellRef.current) return
      updateWindowToElement(appShellRef.current)
    }, 60)

    return () => window.clearTimeout(timer)
  }, [
    isInitialized,
    authState.authenticated,
    isSettingsOpen,
    isAccountDashboardOpen
  ])

  return (
    <QueryClientProvider client={queryClient}>
        <ToastProvider>
        <ToastContext.Provider value={{ showToast }}>
          <div className="relative inline-block bg-transparent">
            {isInitialized ? (
              authState.authenticated ? (
                <div
                  ref={appShellRef}
                  data-app-shell="true"
                  data-aux-open={
                    isSettingsOpen || isAccountDashboardOpen ? "true" : "false"
                  }
                  className="inline-flex flex-col items-start bg-transparent"
                >
                  <SubscribedApp
                    credits={credits}
                    currentLanguage={currentLanguage}
                    setLanguage={updateLanguage}
                    desktopUpdateState={desktopUpdateState}
                    onDownloadUpdate={handleDownloadUpdate}
                    onInstallUpdate={handleInstallUpdate}
                  />
                  <SettingsDialog 
                    open={isSettingsOpen} 
                    onOpenChange={handleCloseSettings} 
                  />
                  <AccountDashboardDialog
                    open={isAccountDashboardOpen}
                    onOpenChange={handleCloseAccountDashboard}
                  />
                  <UninstallOffboardingDialog
                    open={isUninstallOffboardingOpen}
                    authState={authState}
                    onOpenChange={setIsUninstallOffboardingOpen}
                  />
                </div>
              ) : (
                <AuthScreen
                  initialError={authState.error}
                  onAuthenticated={handleAuthenticated}
                />
              )
            ) : (
              <div
                data-size-root="true"
                className="inline-flex items-center justify-center bg-transparent p-4"
              >
                <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/70 px-5 py-4 text-white shadow-lg">
                  <div className="w-6 h-6 border-2 border-white/20 border-t-white/80 rounded-full animate-spin"></div>
                  <p className="text-sm text-white/60">
                    Initializing...
                  </p>
                </div>
              </div>
            )}
            {!authState.authenticated && (
              <UninstallOffboardingDialog
                open={isUninstallOffboardingOpen}
                authState={authState}
                onOpenChange={setIsUninstallOffboardingOpen}
              />
            )}
          </div>
          
          <Toast
            open={toastState.open}
            onOpenChange={(open) =>
              setToastState((prev) => ({ ...prev, open }))
            }
            variant={toastState.variant}
            duration={1500}
          >
            <ToastTitle>{toastState.title}</ToastTitle>
            <ToastDescription>{toastState.description}</ToastDescription>
          </Toast>
          <ToastViewport />
        </ToastContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  )
}

export default App
