import { describe, expect, it } from 'vitest';

import {
  captureFrame,
  captureFrameInPage,
  controlPlayerInPage,
  FRAME_MAX_WIDTH,
  FRAME_QUALITY,
  pausePlayer,
  playPlayer,
  readPlayer,
  seekPlayer,
} from '@/lib/youtube-player';

import { fakeMedia, getChromeFake } from './chrome-fake';

const YOUTUBE = 'https://*.youtube.com/*';

async function videoTab(media = [fakeMedia('VIDEO', { currentTime: 83.4, duration: 600 })]) {
  const fake = getChromeFake();
  const tab = await chrome.tabs.create({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    active: true,
  });
  if (tab.id === undefined) {
    throw new Error('fake tabs.create returned no id');
  }
  const stored = fake.state.tabs.get(tab.id);
  if (stored !== undefined) {
    stored.title = '(1) Song - YouTube';
  }
  fake.state.pageMedia.set(tab.id, media);
  return { tabId: tab.id, media };
}

function grant(): void {
  getChromeFake().state.grantedOrigins.add(YOUTUBE);
}

describe('the player in a YouTube tab', () => {
  it('reads the time, length, paused state and page title', async () => {
    grant();
    const { tabId } = await videoTab();

    expect(await readPlayer(tabId)).toEqual({
      currentTime: 83.4,
      duration: 600,
      paused: false,
      title: '(1) Song - YouTube',
      changed: false,
    });
  });

  it('reports a length not loaded yet as 0', async () => {
    grant();
    const { tabId } = await videoTab([fakeMedia('VIDEO')]);

    expect((await readPlayer(tabId))?.duration).toBe(0);
  });

  it('seeks the video and leaves it playing or paused as it was', async () => {
    grant();
    const { tabId, media } = await videoTab();

    const after = await seekPlayer(tabId, 12);

    expect(media[0]?.currentTime).toBe(12);
    expect(after).toMatchObject({ currentTime: 12, paused: false });
  });

  it('pauses only a playing video, and says whether it did', async () => {
    grant();
    const { tabId, media } = await videoTab();

    expect(await pausePlayer(tabId)).toMatchObject({ paused: true, changed: true });
    expect(media[0]?.paused).toBe(true);
    expect(await pausePlayer(tabId)).toMatchObject({ paused: true, changed: false });
  });

  it('plays a paused video', async () => {
    grant();
    const { tabId, media } = await videoTab([fakeMedia('VIDEO', { paused: true })]);

    await playPlayer(tabId);

    expect(media[0]?.paused).toBe(false);
  });

  it('acts on the video, never on an audio element', async () => {
    grant();
    const audio = fakeMedia('AUDIO', { currentTime: 5 });
    const video = fakeMedia('VIDEO', { currentTime: 40 });
    const { tabId } = await videoTab([audio, video]);

    expect((await readPlayer(tabId))?.currentTime).toBe(40);
    await pausePlayer(tabId);
    expect(audio.paused).toBe(false);
    expect(video.paused).toBe(true);
  });

  it('is null for a page without a video', async () => {
    grant();
    const { tabId } = await videoTab([]);

    expect(await readPlayer(tabId)).toBeNull();
  });

  it('rejects without access to YouTube, and nothing runs in the page', async () => {
    const { tabId, media } = await videoTab();

    await expect(pausePlayer(tabId)).rejects.toThrow(/Cannot access contents of the page/);
    expect(media[0]?.paused).toBe(false);
    expect(getChromeFake().state.injectedTabs).toEqual([]);
  });

  it('ignores a seek to a time that is not a time', async () => {
    grant();
    const { tabId, media } = await videoTab();

    await seekPlayer(tabId, Number.NaN);
    await seekPlayer(tabId, -3);

    expect(media[0]?.currentTime).toBe(83.4);
  });

  it('survives serialization: it is self-contained', () => {
    // The fake rebuilds the function from its source, as Chrome does; one that leaned on an
    // import or a closure would have thrown in the tests above. This states the same directly.
    const rebuilt: unknown = new Function(`return (${controlPlayerInPage.toString()});`)();
    expect(typeof rebuilt).toBe('function');
  });
});

describe('a screenshot of the video', () => {
  function frame(options: Parameters<typeof fakeMedia>[1] = {}) {
    return [
      fakeMedia('VIDEO', { currentTime: 61.5, videoWidth: 1920, videoHeight: 1080, ...options }),
    ];
  }

  it('draws the frame, scaled to 1280 px wide and encodes it as WebP at 0.8', async () => {
    grant();
    const { tabId } = await videoTab(frame());

    const result = await captureFrame(tabId);

    expect(result).toEqual({
      ok: true,
      dataUrl: `data:image/webp;base64,${btoa('1280x720q0.8')}`,
      width: 1280,
      height: 720,
      currentTime: 61.5,
      title: '(1) Song - YouTube',
    });
    const [canvas] = getChromeFake().state.pageCanvases;
    expect(canvas?.drawn).toHaveLength(1);
    expect(canvas?.drawn[0]).toMatchObject({ width: 1280, height: 720 });
    expect(canvas?.encoded).toEqual([{ type: 'image/webp', quality: FRAME_QUALITY }]);
    expect(FRAME_MAX_WIDTH).toBe(1280);
  });

  it('keeps a frame narrower than the limit at its own size', async () => {
    grant();
    const { tabId } = await videoTab(frame({ videoWidth: 640, videoHeight: 360 }));

    expect(await captureFrame(tabId)).toMatchObject({ ok: true, width: 640, height: 360 });
  });

  it('reports a page without a video, and a video with no picture yet', async () => {
    grant();
    const empty = await videoTab([]);
    const loading = await videoTab([fakeMedia('VIDEO')]);
    const stalled = await videoTab(frame({ readyState: 1 }));

    expect(await captureFrame(empty.tabId)).toEqual({ ok: false, reason: 'noVideo' });
    expect(await captureFrame(loading.tabId)).toEqual({ ok: false, reason: 'notReady' });
    expect(await captureFrame(stalled.tabId)).toEqual({ ok: false, reason: 'notReady' });
  });

  it('reports a tainted canvas as blocked', async () => {
    grant();
    const { tabId } = await videoTab(frame({ tainted: true }));

    expect(await captureFrame(tabId)).toEqual({ ok: false, reason: 'blocked' });
  });

  it('rejects without access to YouTube, and draws nothing', async () => {
    const { tabId } = await videoTab(frame());

    await expect(captureFrame(tabId)).rejects.toThrow(/Cannot access contents of the page/);
    expect(getChromeFake().state.pageCanvases).toEqual([]);
  });

  it('survives serialization: it is self-contained', () => {
    const rebuilt: unknown = new Function(`return (${captureFrameInPage.toString()});`)();
    expect(typeof rebuilt).toBe('function');
  });
});
