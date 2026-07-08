import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPluginInteractiveHandlers, registerPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';

vi.mock('../src/core/lark-logger', () => ({
  larkLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/messaging/outbound/send', () => ({
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
  updateCardFeishu: vi.fn(),
}));

import {
  clearFeishuPluginInteractiveDedupeForTest,
  dispatchFeishuPluginInteractiveHandler,
} from '../src/channel/interactive-dispatch';

afterEach(() => {
  vi.useRealTimers();
  clearPluginInteractiveHandlers();
  clearFeishuPluginInteractiveDedupeForTest();
});

describe('dispatchFeishuPluginInteractiveHandler', () => {
  it('routes dot-form Feishu card actions to the registered dot namespace handler', async () => {
    const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'handler reached' } });
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_action.submit',
      handler,
    });

    const response = await dispatchFeishuPluginInteractiveHandler({
      cfg: {} as any,
      accountId: 'account-a',
      data: {
        operator: { open_id: 'ou_sender' },
        open_chat_id: 'oc_chat',
        open_message_id: 'om_card',
        action: {
          value: {
            action: 'example_action.submit',
            item_id: 'ITEM-1',
          },
        },
      },
    });

    expect(response).toEqual({ toast: { type: 'success', content: 'handler reached' } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'feishu',
      accountId: 'account-a',
      senderId: 'ou_sender',
      conversationId: 'oc_chat',
      messageId: 'om_card',
      namespace: 'example_action.submit',
      payload: '',
      action: 'example_action.submit',
    }));
  });

  it('routes Feishu form submit by action.name when action.value is absent', async () => {
    const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'form handler reached' } });
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_form.submit',
      handler,
    });

    const rawEvent = {
      operator: { open_id: 'ou_sender' },
      context: {
        open_chat_id: 'oc_chat',
        open_message_id: 'om_card',
      },
      action: {
        tag: 'button',
        name: 'example_form.submit',
        form_value: {
          field_a: 'alpha',
          field_b: 'beta',
        },
      },
    };

    const response = await dispatchFeishuPluginInteractiveHandler({
      cfg: {} as any,
      accountId: 'account-a',
      data: rawEvent,
    });

    expect(response).toEqual({ toast: { type: 'success', content: 'form handler reached' } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'feishu',
      accountId: 'account-a',
      senderId: 'ou_sender',
      conversationId: 'oc_chat',
      messageId: 'om_card',
      namespace: 'example_form.submit',
      payload: '',
      action: 'example_form.submit',
      rawEvent,
    }));
  });

  it('treats undefined handler result as unhandled and does not commit dedupe', async () => {
    const handler = vi.fn().mockReturnValue(undefined);
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_unhandled.submit',
      handler,
    });
    const event = cardActionEvent('example_unhandled.submit');

    const first = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    const second = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('treats handled false result as unhandled and does not commit dedupe', async () => {
    const handler = vi.fn().mockReturnValue({ handled: false });
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_handled_false.submit',
      handler,
    });
    const event = cardActionEvent('example_handled_false.submit');

    const first = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    const second = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('treats empty object result as handled, commits dedupe, and sends no synchronous Feishu response', async () => {
    const handler = vi.fn().mockReturnValue({});
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_empty_ack.submit',
      handler,
    });
    const event = cardActionEvent('example_empty_ack.submit');

    const first = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    const second = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe different form submissions from the same card and action', async () => {
    const handler = vi.fn().mockReturnValue({});
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_form.submit',
      handler,
    });

    const first = formSubmitEvent('evt_form_a', {
      reject_type: '普通驳回',
      reject_node: '提出用印申请 -- 申蕾(00071716)',
    });
    const second = formSubmitEvent('evt_form_b', {
      reject_type: '退回发起人',
      reject_node: '部门负责人审批 -- 张三(00000001)',
    });

    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: first });
    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: second });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ rawEvent: first }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ rawEvent: second }));
  });

  it('dedupes an exact Feishu event replay by event id', async () => {
    const handler = vi.fn().mockReturnValue({});
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_form.submit',
      handler,
    });
    const event = formSubmitEvent('evt_form_replay', {
      reject_type: '普通驳回',
      reject_node: '提出用印申请 -- 申蕾(00071716)',
    });

    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dedupes an exact Feishu event replay while the handler is still in flight', async () => {
    let resolveHandler!: (value: Record<string, never>) => void;
    const handler = vi.fn((): Promise<Record<string, never>> => new Promise((resolve) => {
      resolveHandler = resolve;
    }));
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_form.submit',
      handler,
    });
    const event = formSubmitEvent('evt_form_in_flight', {
      reject_type: '普通驳回',
      reject_node: '提出用印申请 -- 申蕾(00071716)',
    });

    const first = dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    await Promise.resolve();
    const second = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    resolveHandler({});

    expect(second).toBeUndefined();
    expect(await first).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('expires handled interactive dedupe entries after the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T00:00:00.000Z'));
    const handler = vi.fn().mockReturnValue({});
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_form.submit',
      handler,
    });
    const event = formSubmitEvent('evt_form_ttl', {
      reject_type: '普通驳回',
      reject_node: '提出用印申请 -- 申蕾(00071716)',
    });

    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    vi.advanceTimersByTime(10 * 60 * 1000);
    await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('treats toast result as handled and commits dedupe', async () => {
    const handler = vi.fn().mockReturnValue({ toast: { type: 'success', content: 'done' } });
    registerPluginInteractiveHandler('example-plugin', {
      channel: 'feishu',
      namespace: 'example_toast.submit',
      handler,
    });
    const event = cardActionEvent('example_toast.submit');

    const first = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });
    const second = await dispatchFeishuPluginInteractiveHandler({ cfg: {} as any, accountId: 'account-a', data: event });

    expect(first).toEqual({ toast: { type: 'success', content: 'done' } });
    expect(second).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function cardActionEvent(action: string) {
  return {
    operator: { open_id: 'ou_sender' },
    open_chat_id: 'oc_chat',
    open_message_id: `om_${action.replace(/[^a-z0-9]/gi, '_')}`,
    action: {
      value: { action },
    },
  };
}

function formSubmitEvent(eventId: string, formValue: Record<string, unknown>) {
  return {
    event_id: eventId,
    operator: { open_id: 'ou_sender' },
    context: {
      open_chat_id: 'oc_chat',
      open_message_id: 'om_same_card',
    },
    action: {
      tag: 'button',
      name: 'example_form.submit',
      form_value: formValue,
    },
  };
}
