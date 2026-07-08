/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu interactive dispatch wrapper.
 *
 * This module adapts Feishu `card.action.trigger` events into OpenClaw's
 * standard interactive dispatch pipeline:
 * - Plugins register via `api.registerInteractiveHandler({ channel, namespace, handler })`
 * - Channel forwards via `dispatchPluginInteractiveHandler()`
 *
 * We intentionally do NOT maintain any channel-local global registry here.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
// NOTE: This is the SDK-standard interactive pipeline.
import { dispatchPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';
import { resolveCardCallbackOperatorId } from '../core/card-action-operator';
import { larkLogger } from '../core/lark-logger';
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from '../messaging/outbound/send';

const log = larkLogger('channel/interactive-dispatch');
const FEISHU_INTERACTIVE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const FEISHU_INTERACTIVE_DEDUPE_MAX_ENTRIES = 4096;
const handledInteractiveDedupe = new Map<string, { expiresAt: number }>();

export function clearFeishuPluginInteractiveDedupeForTest(): void {
  handledInteractiveDedupe.clear();
}

interface FeishuCardActionTriggerEvent {
  event_id?: string;
  eventId?: string;
  operator?: { open_id?: string; user_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: { name?: string; value?: { action?: string }; form_value?: unknown };
  form_value?: unknown;
}

function extractBasics(data: unknown): {
  action: string;
  eventId?: string;
  senderOpenId?: string;
  openChatId?: string;
  openMessageId?: string;
  actionFingerprint: string;
} | null {
  try {
    const ev = data as FeishuCardActionTriggerEvent;
    const action = ev.action?.value?.action ?? ev.action?.name;
    if (!action || typeof action !== 'string') return null;
    const openChatId = ev.open_chat_id ?? ev.context?.open_chat_id;
    const openMessageId = ev.open_message_id ?? ev.context?.open_message_id;
    return {
      action: action.trim(),
      eventId: ev.event_id ?? ev.eventId,
      senderOpenId: resolveCardCallbackOperatorId(ev.operator),
      openChatId,
      openMessageId,
      actionFingerprint: stableStringify({
        value: ev.action?.value,
        form_value: ev.action?.form_value ?? ev.form_value,
      }),
    };
  } catch {
    return null;
  }
}

export type FeishuInteractiveHandlerResponse = unknown;

export interface FeishuInteractiveHandlerContext {
  channel: 'feishu';
  accountId: string;
  senderId?: string;
  conversationId?: string;
  messageId?: string;
  namespace: string;
  payload: string;
  action: string;
  rawEvent: unknown;
  respond: {
    reply: (args: { text: string }) => Promise<void>;
    followUp: (args: { text: string }) => Promise<void>;
    /**
     * Best-effort "edit current message" mapping.
     * In Feishu, we prefer updating the original interactive card when possible.
     */
    editMessage: (args: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
}

function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * Dispatch a Feishu interactive card action to business plugins through
 * the OpenClaw SDK's standard interactive dispatch pipeline.
 *
 * Returns `undefined` when:
 * - the event does not look like an interactive action we can route, or
 * - no plugin handler is registered for the derived namespace.
 *
 * @param params.cfg - OpenClaw config snapshot.
 * @param params.accountId - Current Feishu account id.
 * @param params.data - Raw `card.action.trigger` event payload.
 */
export async function dispatchFeishuPluginInteractiveHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: unknown;
}): Promise<unknown | undefined> {
  const basics = extractBasics(params.data);
  if (!basics) return undefined;
  if (!basics.action) return undefined;

  const respond: FeishuInteractiveHandlerContext['respond'] = {
    reply: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    followUp: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    editMessage: async (args: { text?: string; blocks?: unknown[] }) => {
      if (!basics.openMessageId) {
        if (Array.isArray(args?.blocks) && args.blocks.length && basics.openChatId) {
          await sendCardFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
          return;
        }
        if (typeof args?.text === 'string' && args.text.trim() && basics.openChatId) {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            text: args.text,
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
        }
        return;
      }
      if (Array.isArray(args?.blocks) && args.blocks.length) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
          accountId: params.accountId,
        });
        return;
      }
      if (typeof args?.text === 'string' && args.text.trim()) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: buildMarkdownCard(args.text),
          accountId: params.accountId,
        });
        return;
      }
      await updateCardFeishu({
        cfg: params.cfg,
        messageId: basics.openMessageId,
        card: { schema: '2.0', body: { elements: [] } },
        accountId: params.accountId,
      });
    },
  };

  try {
    const dedupeId = buildInteractiveDedupeId(params.accountId, basics);
    if (hasActiveInteractiveDedupe(dedupeId)) {
      return undefined;
    }

    let dedupeClaimed = false;
    let cardResponse: FeishuInteractiveHandlerResponse | undefined;
    const result = await dispatchPluginInteractiveHandler<{
      channel: 'feishu';
      namespace: string;
      // handler returns unknown so Feishu can synchronously return {toast, card}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (ctx: FeishuInteractiveHandlerContext) => Promise<any> | any;
    }>({
      channel: 'feishu',
      data: basics.action,
      invoke: async (match: {
        registration: { handler: (ctx: FeishuInteractiveHandlerContext) => Promise<unknown> | unknown };
        namespace: string;
        payload: string;
      }) => {
        if (!claimInteractiveDedupe(dedupeId)) {
          return { handled: false };
        }
        dedupeClaimed = true;
        const { registration, namespace, payload } = match;
        const handlerCtx: FeishuInteractiveHandlerContext = {
          channel: 'feishu',
          accountId: params.accountId,
          senderId: basics.senderOpenId,
          conversationId: basics.openChatId,
          messageId: basics.openMessageId,
          namespace,
          payload,
          action: basics.action,
          rawEvent: params.data,
          respond,
        };
        cardResponse = await registration.handler(handlerCtx);
        if (isUnhandledInteractiveResponse(cardResponse)) {
          releaseInteractiveDedupe(dedupeId);
          dedupeClaimed = false;
          return { handled: false };
        }
        return { handled: true };
      },
    });

    log.debug(
      `interactive dispatch result: action=${basics.action}, matched=${result.matched}, handled=${result.handled}`,
    );
    if (!result.matched) return undefined;
    if (!result.handled || isUnhandledInteractiveResponse(cardResponse)) {
      if (dedupeClaimed) {
        releaseInteractiveDedupe(dedupeId);
      }
      return undefined;
    }
    markInteractiveDedupeHandled(dedupeId);
    if (isEmptyObject(cardResponse)) return undefined;
    return cardResponse;
  } catch (err) {
    releaseInteractiveDedupe(buildInteractiveDedupeId(params.accountId, basics));
    log.warn(`interactive dispatch failed: ${String(err)}`);
    return {
      toast: {
        type: 'error',
        content: '交互处理失败，请稍后重试',
      },
    };
  }
}

function isUnhandledInteractiveResponse(value: unknown): boolean {
  if (value === undefined) return true;
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { handled?: unknown }).handled === false;
}

function isEmptyObject(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

function buildInteractiveDedupeId(accountId: string, basics: {
  action: string;
  eventId?: string;
  senderOpenId?: string;
  openChatId?: string;
  openMessageId?: string;
  actionFingerprint: string;
}): string {
  const eventOrAction = basics.eventId
    ? `event:${basics.eventId}`
    : `action:${basics.action}:${basics.actionFingerprint}`;
  return `feishu:${accountId}:${basics.openChatId ?? '-'}:${basics.openMessageId ?? '-'}:${
    basics.senderOpenId ?? '-'
  }:${eventOrAction}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasActiveInteractiveDedupe(dedupeId: string): boolean {
  const now = Date.now();
  pruneInteractiveDedupe(now);
  const entry = handledInteractiveDedupe.get(dedupeId);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    handledInteractiveDedupe.delete(dedupeId);
    return false;
  }
  return true;
}

function claimInteractiveDedupe(dedupeId: string): boolean {
  if (hasActiveInteractiveDedupe(dedupeId)) {
    return false;
  }
  setInteractiveDedupe(dedupeId, Date.now());
  return true;
}

function markInteractiveDedupeHandled(dedupeId: string): void {
  setInteractiveDedupe(dedupeId, Date.now());
}

function releaseInteractiveDedupe(dedupeId: string): void {
  handledInteractiveDedupe.delete(dedupeId);
}

function setInteractiveDedupe(dedupeId: string, now: number): void {
  pruneInteractiveDedupe(now);
  if (!handledInteractiveDedupe.has(dedupeId)) {
    while (handledInteractiveDedupe.size >= FEISHU_INTERACTIVE_DEDUPE_MAX_ENTRIES) {
      const oldest = handledInteractiveDedupe.keys().next().value as string | undefined;
      if (!oldest) break;
      handledInteractiveDedupe.delete(oldest);
    }
  }
  handledInteractiveDedupe.set(dedupeId, {
    expiresAt: now + FEISHU_INTERACTIVE_DEDUPE_TTL_MS,
  });
}

function pruneInteractiveDedupe(now: number): void {
  for (const [key, entry] of handledInteractiveDedupe) {
    if (entry.expiresAt <= now) {
      handledInteractiveDedupe.delete(key);
    }
  }
}
