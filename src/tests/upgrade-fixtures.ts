/**
 * What `chrome.storage.local` holds after versions 8.3 to 9.1 (sync protocol v1), written out by
 * hand in their shapes: sessions, snapshots, settings, YouTube notes with screenshots, and the v1
 * cloud keys. Not a test file. The ids and stamps are odd on purpose.
 */
const IMAGE = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function session(id: string, kind: 'saved' | 'history', updatedAt: number) {
  return {
    schemaVersion: 1,
    id,
    kind,
    name: `${id} name`,
    origin: kind === 'saved' ? 'manual' : 'alarm',
    createdAt: 1_700_000_000_000,
    updatedAt,
    windows: [
      {
        state: 'normal',
        focused: true,
        groups: [{ title: 'G', color: 'blue', collapsed: false }],
        tabs: [
          { url: 'https://a.example/x?y=1', title: 'A', pinned: true, active: false },
          { url: 'https://b.example/', title: 'B', pinned: false, active: true, groupIndex: 0 },
        ],
      },
    ],
  };
}

function summary(value: ReturnType<typeof session>) {
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    origin: value.origin,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    windowCount: 1,
    tabCount: 2,
    bytes: JSON.stringify(value).length,
  };
}

/** Local storage of a device on `version`, with or without the v1 cloud keys. */
export function v1Storage(
  version: '8.3' | '8.4' | '9.0' | '9.1',
  signedIn: boolean,
): Record<string, unknown> {
  const saved = session('s-1_odd', 'saved', 1_700_000_000_123.5);
  const future = session('s-future', 'saved', 9_999_999_999_999);
  const snapshot = session('h1', 'history', 1_700_000_000_500);
  const storage: Record<string, unknown> = {
    'session:s-1_odd': saved,
    'session:s-future': future,
    'session:h1': snapshot,
    'session:newer': { ...session('newer', 'saved', 5), schemaVersion: 99 },
    sessionIndex: {
      schemaVersion: 1,
      sessions: [summary(future), summary(snapshot), summary(saved)],
    },
    sessionSettings: {
      historyEnabled: true,
      historyIntervalMinutes: 7,
      historyMaxSnapshots: 20,
      restoreLazy: 'auto',
    },
    historyMeta: { lastHash: 'abc', lastSnapshotAt: 1_700_000_000_500 },
    shortcutPrompted: ['assemble-tabs'],
  };
  if (version === '9.0' || version === '9.1') {
    const entries = Array.from({ length: 105 }, (_, index) => ({
      id: `e${index}`,
      at: index,
      text: `note ${index}`,
      imageId: `img${index}`,
      createdAt: 1_700_000_001_000 + index,
      updatedAt: 1_700_000_001_000 + index,
    }));
    storage['notes:dQw4w9WgXcQ'] = {
      schemaVersion: 1,
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Video',
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_002_000,
      entries,
    };
    storage.notesIndex = {
      schemaVersion: 1,
      notes: [
        {
          videoId: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Video',
          entryCount: entries.length,
          createdAt: 1_700_000_001_000,
          updatedAt: 1_700_000_002_000,
        },
      ],
    };
    for (const entry of entries) {
      storage[`noteImage:${entry.imageId}`] = IMAGE;
    }
  }
  if (signedIn) {
    storage.cloudAccount = {
      token: 'v1-bearer',
      expiresAt: 4_000_000_000_000,
      email: 'Person@Example.com',
    };
    storage.cloudSyncKey = 'djEta2V5';
    storage.cloudSyncMeta = {
      owner: 'person@example.com',
      keyId: 'abcd',
      cursor: 40,
      lastSyncAt: 1,
      dirtySessions: { 's-1_odd': 1 },
      deletedSessions: {},
      knownVersions: {},
      settingsUpdatedAt: 0,
      settingsDirty: false,
    };
  }
  return storage;
}

export const V1_CLOUD_KEYS = ['cloudAccount', 'cloudSyncKey', 'cloudSyncMeta'] as const;
