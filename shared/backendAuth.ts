import type { ConnectedAppIntegration } from "./integrations";

export type SubscriptionPlan = "free" | "pro" | "enterprise";

export type SubscriptionStatus =
  | "trial"
  | "active"
  | "past_due"
  | "cancelled"
  | "suspended";

export type UsageAction =
  | "solve"
  | "debug"
  | "screenshot"
  | "live_interview"
  | "computer_use"
  | "agent";

export interface UsageRateLimits {
  solveDaily: number;
  debugDaily: number;
  requestsPerHour: number;
}

export interface UsageSnapshot {
  solvesToday: number;
  debugToday: number;
  screenshotsToday: number;
  requestsToday: number;
  requestsThisHour: number;
  remainingRequestsToday: number;
  remainingSolveDaily: number;
  remainingDebugDaily: number;
  remainingRequestsThisHour: number;
  totalSolveCount: number;
  totalDebugCount: number;
  totalScreenshotCount: number;
  blockedAttemptsToday: number;
  lastUsageAt: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: "user";
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
  subscriptionSource: "manual" | "stripe" | "dodo";
  cancelAtPeriodEnd: boolean;
  rateLimits: UsageRateLimits;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  subscriptionStartedAt: string | null;
  subscriptionRenewsAt: string | null;
}

export interface BillingSummary {
  provider: "manual" | "stripe" | "dodo";
  pricePerMonthUsd: number;
  unlimited: boolean;
  checkoutEnabled: boolean;
  canManageBilling: boolean;
  cancelAtPeriodEnd: boolean;
  statusMessage: string;
}

export interface AuthSession {
  token: string;
  user: AuthenticatedUser;
  usage: UsageSnapshot;
}

export interface AuthState {
  authenticated: boolean;
  session: AuthSession | null;
  error?: string;
}

export interface UsageDecision {
  allowed: boolean;
  error?: string;
  usage?: UsageSnapshot;
  session?: AuthSession | null;
}

export interface UsageEventSummary {
  id: string;
  action: UsageAction;
  allowed: boolean;
  reason: string | null;
  createdAt: string;
}

export interface DailyActivityPoint {
  day: string;
  solves: number;
  debug: number;
  screenshots: number;
  blocked: number;
}

export interface UserDashboardData {
  user: AuthenticatedUser;
  usage: UsageSnapshot;
  billing: BillingSummary;
  integrations: ConnectedAppIntegration[];
  recentEvents: UsageEventSummary[];
  dailyActivity: DailyActivityPoint[];
}

export interface BillingSessionResponse {
  url: string;
}
