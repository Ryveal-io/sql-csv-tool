import { useEffect, useRef } from 'react';
import {
  isVsCodeEnvironment,
  postMessageToExtension,
  onMessageFromExtension,
} from '../services/vscodeMessenger';
import type { ExtensionToWebviewMessage } from '../types/messages';

interface UseVsCodeMessagingOptions {
  onLoad: (fileName: string, content: Uint8Array) => Promise<void>;
  onRequestExport?: () => Promise<void>;
  onSetSql?: (sql: string) => void;
  onRunQuery?: (sql: string) => void;
  onReload?: () => void;
}

export function useVsCodeMessaging({
  onLoad,
  onRequestExport,
  onSetSql,
  onRunQuery,
  onReload,
}: UseVsCodeMessagingOptions) {
  const isVsCode = isVsCodeEnvironment();
  const callbacksRef = useRef({ onLoad, onRequestExport, onSetSql, onRunQuery, onReload });
  callbacksRef.current = { onLoad, onRequestExport, onSetSql, onRunQuery, onReload };

  useEffect(() => {
    if (!isVsCode) return;

    const cleanup = onMessageFromExtension(async (msg: ExtensionToWebviewMessage) => {
      switch (msg.type) {
        case 'load': {
          try {
            console.log('[Chomper] Fetching file from URI:', msg.fileUri);
            const response = await fetch(msg.fileUri);
            if (!response.ok) {
              throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
            }
            const buffer = await response.arrayBuffer();
            console.log('[Chomper] Fetched', buffer.byteLength, 'bytes');
            await callbacksRef.current.onLoad(msg.fileName, new Uint8Array(buffer));
          } catch (err) {
            console.error('[Chomper] Failed to fetch file:', err);
          }
          break;
        }
        case 'requestExport':
          await callbacksRef.current.onRequestExport?.();
          break;
        case 'setSql':
          callbacksRef.current.onSetSql?.(msg.sql);
          break;
        case 'runQuery':
          callbacksRef.current.onRunQuery?.(msg.sql);
          break;
        case 'reload':
          callbacksRef.current.onReload?.();
          break;
      }
    });

    postMessageToExtension({ type: 'ready' });

    return cleanup;
  }, [isVsCode]);

  return { isVsCode };
}
