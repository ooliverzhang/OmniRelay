import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, deletePlatformCredential, setPlatformCredential } from './client';
import type {
  ConversationRow,
  DashboardSummary,
  DeadLetterRow,
  IdentityRow,
  LogRow,
  LoginRequest,
  MessageRow,
  OkResponse,
  PagedResult,
  Platform,
  PlatformActionResponse,
  PlatformUpdateRequest,
  PlatformView,
  QueueRow,
  RetryResponse,
  RuleTestRequest,
  RuleTestResponse,
  RuleUpsertRequest,
  RuleView,
  SessionView,
  SettingsUpdateRequest,
  SettingsView,
} from './types';
import { DASHBOARD_REFRESH_MS } from '../lib/constants';
import { buildQuery } from '../lib/format';

export const queryKeys = {
  session: ['session'] as const,
  dashboard: ['dashboard'] as const,
  platforms: ['platforms'] as const,
  platform: (id: string) => ['platforms', id] as const,
  rules: ['rules'] as const,
  rule: (id: string) => ['rules', id] as const,
  conversations: (params: { platform: string; search: string; page: number; pageSize: number }) =>
    ['conversations', params.platform, params.search, params.page, params.pageSize] as const,
  messages: (params: {
    platform: string;
    conversationNativeId: string;
    senderNativeId: string;
    page: number;
    pageSize: number;
  }) =>
    [
      'messages',
      params.platform,
      params.conversationNativeId,
      params.senderNativeId,
      params.page,
      params.pageSize,
    ] as const,
  identities: (params: { platform: string; search: string; page: number; pageSize: number }) =>
    ['identities', params.platform, params.search, params.page, params.pageSize] as const,
  queues: (params: { status: string; platform: string; page: number; pageSize: number }) =>
    ['queues', params.status, params.platform, params.page, params.pageSize] as const,
  deadLetters: (params: { platform: string; page: number; pageSize: number }) =>
    ['dead-letters', params.platform, params.page, params.pageSize] as const,
  logs: (params: {
    level: string;
    platform: string;
    search: string;
    page: number;
    pageSize: number;
  }) =>
    ['logs', params.level, params.platform, params.search, params.page, params.pageSize] as const,
  settings: ['settings'] as const,
};

export interface ListQuery {
  page: number;
  pageSize: number;
}

/* ------------------------------------------------------------------ session */

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => apiClient.get<SessionView>('/api/session', signal),
    staleTime: 30_000,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => apiClient.post<SessionView>('/api/login', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<OkResponse>('/api/logout'),
    onSuccess: () => {
      queryClient.setQueryData<SessionView>(queryKeys.session, (previous) =>
        previous
          ? { ...previous, authenticated: false, username: null, expiresAt: null }
          : previous,
      );
      queryClient.removeQueries({ queryKey: queryKeys.dashboard });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    },
  });
}

/* ---------------------------------------------------------------- dashboard */

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => apiClient.get<DashboardSummary>('/api/dashboard', signal),
    refetchInterval: DASHBOARD_REFRESH_MS,
  });
}

/* ---------------------------------------------------------------- platforms */

export function usePlatforms() {
  return useQuery({
    queryKey: queryKeys.platforms,
    queryFn: ({ signal }) => apiClient.get<{ items: PlatformView[] }>('/api/platforms', signal),
  });
}

export function usePlatform(platform: string | undefined) {
  return useQuery({
    queryKey: queryKeys.platform(platform ?? ''),
    queryFn: ({ signal }) => apiClient.get<PlatformView>(`/api/platforms/${platform}`, signal),
    enabled: Boolean(platform),
  });
}

export function useUpdatePlatform() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ platform, body }: { platform: string; body: PlatformUpdateRequest }) =>
      apiClient.patch<PlatformView>(`/api/platforms/${platform}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.platform(data.platform), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function usePlatformAction(action: 'test' | 'reconnect') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (platform: string) =>
      apiClient.post<PlatformActionResponse>(`/api/platforms/${platform}/${action}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/**
 * Refreshes every cache entry touched by a credential write.
 *
 * Only masked data is ever stored in the query cache: the mutation arguments
 * (plaintext values) live in the mutation object and are dropped by the caller
 * as soon as the request settles.
 */
function useInvalidatePlatformCredentials() {
  const queryClient = useQueryClient();
  return (view: PlatformView) => {
    queryClient.setQueryData(queryKeys.platform(view.platform), view);
    void queryClient.invalidateQueries({ queryKey: queryKeys.platform(view.platform) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.platforms });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
  };
}

export interface SetPlatformCredentialVariables {
  platform: Platform;
  values: Record<string, string>;
}

export function useSetPlatformCredential() {
  const invalidate = useInvalidatePlatformCredentials();
  return useMutation<PlatformView, Error, SetPlatformCredentialVariables>({
    mutationFn: ({ platform, values }) => setPlatformCredential(platform, values),
    onSuccess: invalidate,
  });
}

export interface DeletePlatformCredentialVariables {
  platform: Platform;
  env: string;
}

export function useDeletePlatformCredential() {
  const invalidate = useInvalidatePlatformCredentials();
  return useMutation<PlatformView, Error, DeletePlatformCredentialVariables>({
    mutationFn: ({ platform, env }) => deletePlatformCredential(platform, env),
    onSuccess: invalidate,
  });
}

/* -------------------------------------------------------------------- rules */

export function useRules() {
  return useQuery({
    queryKey: queryKeys.rules,
    queryFn: ({ signal }) => apiClient.get<{ items: RuleView[] }>('/api/rules', signal),
  });
}

export function useRule(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.rule(id ?? ''),
    queryFn: ({ signal }) => apiClient.get<RuleView>(`/api/rules/${id}`, signal),
    enabled: Boolean(id),
  });
}

function useInvalidateRules() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.rules });
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
  };
}

export function useCreateRule() {
  const invalidate = useInvalidateRules();
  return useMutation<RuleView, Error, RuleUpsertRequest>({
    mutationFn: (body) => apiClient.post<RuleView>('/api/rules', body),
    onSuccess: invalidate,
  });
}

export function useUpdateRule() {
  const invalidate = useInvalidateRules();
  return useMutation<RuleView, Error, { id: string; body: RuleUpsertRequest }>({
    mutationFn: ({ id, body }) => apiClient.patch<RuleView>(`/api/rules/${id}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteRule() {
  const invalidate = useInvalidateRules();
  return useMutation<OkResponse, Error, string>({
    mutationFn: (id) => apiClient.delete<OkResponse>(`/api/rules/${id}`),
    onSuccess: invalidate,
  });
}

export function useToggleRule() {
  const invalidate = useInvalidateRules();
  return useMutation<RuleView, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      apiClient.post<RuleView>(`/api/rules/${id}/toggle`, { enabled }),
    onSuccess: invalidate,
  });
}

export function useReorderRules() {
  const invalidate = useInvalidateRules();
  return useMutation<{ items: RuleView[] }, Error, string[]>({
    mutationFn: (orderedIds) =>
      apiClient.post<{ items: RuleView[] }>('/api/rules/reorder', { orderedIds }),
    onSuccess: invalidate,
  });
}

export function useRuleTest() {
  return useMutation({
    mutationFn: (body: RuleTestRequest) =>
      apiClient.post<RuleTestResponse>('/api/rules/test', body),
  });
}

/* --------------------------------------------------------------- list pages */

export function useConversations(params: {
  platform: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: queryKeys.conversations(params),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<ConversationRow>>(
        `/api/conversations?${buildQuery({
          platform: params.platform,
          search: params.search,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useMessages(params: {
  platform: string;
  conversationNativeId: string;
  senderNativeId?: string;
  page: number;
  pageSize: number;
  enabled?: boolean;
}) {
  const senderNativeId = params.senderNativeId ?? '';
  return useQuery({
    queryKey: queryKeys.messages({
      platform: params.platform,
      conversationNativeId: params.conversationNativeId,
      senderNativeId,
      page: params.page,
      pageSize: params.pageSize,
    }),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<MessageRow>>(
        `/api/messages?${buildQuery({
          platform: params.platform,
          conversationNativeId: params.conversationNativeId,
          senderNativeId,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
    enabled: params.enabled ?? true,
  });
}

export function useIdentities(params: {
  platform: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: queryKeys.identities(params),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<IdentityRow>>(
        `/api/identities?${buildQuery({
          platform: params.platform,
          search: params.search,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useQueues(params: {
  status: string;
  platform: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: queryKeys.queues(params),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<QueueRow>>(
        `/api/queues?${buildQuery({
          status: params.status,
          platform: params.platform,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useDeadLetters(params: { platform: string; page: number; pageSize: number }) {
  return useQuery({
    queryKey: queryKeys.deadLetters(params),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<DeadLetterRow>>(
        `/api/dead-letters?${buildQuery({
          platform: params.platform,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useLogs(params: {
  level: string;
  platform: string;
  search: string;
  page: number;
  pageSize: number;
}) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: ({ signal }) =>
      apiClient.get<PagedResult<LogRow>>(
        `/api/logs?${buildQuery({
          level: params.level,
          platform: params.platform,
          search: params.search,
          page: params.page,
          pageSize: params.pageSize,
        })}`,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
}

/* ------------------------------------------------------------- write actions */

export function useRetryQueueItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<RetryResponse>(`/api/queues/${id}/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['queues'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useRetryDeadLetter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.post<RetryResponse>(`/api/dead-letters/${id}/retry`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dead-letters'] });
      void queryClient.invalidateQueries({ queryKey: ['queues'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useDeleteDeadLetter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete<OkResponse>(`/api/dead-letters/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dead-letters'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/* ----------------------------------------------------------------- settings */

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => apiClient.get<SettingsView>('/api/settings', signal),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsUpdateRequest) =>
      apiClient.patch<SettingsView>('/api/settings', body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings, data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
}
