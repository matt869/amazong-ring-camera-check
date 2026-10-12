'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FRAME_HEIGHT, FRAME_WIDTH, MotionDetector, SENSITIVITY_FRACTION, toGray, type Sensitivity } from '@/lib/sensor/motion';

const KEY_STORE = 'checkin_sensor_key';
const QUEUE_STORE = 'checkin_sensor_queue';
const SENS_STORE = 'checkin_sensor_sensitivity';
const SAMPLE_MS = 500;
const HEARTBEAT_MS = 60_000;

type Phase = 'loading' | 'need-key' | 'insecure' | 'ready' | 'starting' | 'watching' | 'camera-error' | 'revoked';

// Storage can be unavailable (private mode, blocked); the sensor must still work.
const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * Turns this device's camera into a motion sensor. Video is analysed here, in
 * the browser, and never uploaded; only motion timestamps are sent.
 */
export default function WebcamSensor() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [cameraError, setCameraError] = useState('');
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [lastMotion, setLastMotion] = useState<number | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [queued, setQueued] = useState(0);
  const [level, setLevel] = useState(0);
  const [dark, setDark] = useState(false);
  const [preview, setPreview] = useState(true);
  const [sensitivity, setSensitivity] = useState<Sensitivity>('medium');

  const keyRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detector = useRef(new MotionDetector('medium'));
  const queue = useRef<number[]>([]);
  const sending = useRef(false);
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);

  // Pick up the key from the setup link (#k=...), then hide it from the address bar.
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('k');
    if (fromHash) {
      store.set(KEY_STORE, fromHash);
      history.replaceState(null, '', window.location.pathname);
    }
    keyRef.current = fromHash ?? store.get(KEY_STORE);
    try {
      queue.current = JSON.parse(store.get(QUEUE_STORE) ?? '[]');
    } catch {
      queue.current = [];
    }
    setQueued(queue.current.length);
    const s = store.get(SENS_STORE) as Sensitivity | null;
    if (s === 'low' || s === 'medium' || s === 'high') {
      setSensitivity(s);
      detector.current.sensitivity = s;
    }
    if (!keyRef.current) setPhase('need-key');
    else if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) setPhase('insecure');
    else setPhase('ready');
  }, []);

  const saveQueue = () => {
    store.set(QUEUE_STORE, JSON.stringify(queue.current.slice(-500)));
    setQueued(queue.current.length);
  };

  /** Sends queued motion (and doubles as the heartbeat). Keeps events if the network is down. */
  const flush = useCallback(async () => {
    if (sending.current || !keyRef.current) return;
    sending.current = true;
    const batch = queue.current.slice();
    try {
      const res = await fetch('/api/sensor/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyRef.current}` },
        body: JSON.stringify({ motion: batch }),
      });
      if (res.status === 401) {
        setPhase('revoked');
        store.remove(KEY_STORE);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { device?: string };
      if (body.device) setDeviceName(body.device);
      queue.current = queue.current.filter((t) => !batch.includes(t));
      saveQueue();
      setLastSync(Date.now());
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      sending.current = false;
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
      if (nav.wakeLock && document.visibilityState === 'visible') wakeLock.current = await nav.wakeLock.request('screen');
    } catch {
      // Not supported or refused; the page notes that the screen must stay on.
    }
  }, []);

  const start = useCallback(async () => {
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      detector.current.reset();
      setPhase('watching');
      await requestWakeLock();
      void flush();
    } catch (err) {
      const name = (err as DOMException).name;
      setCameraError(
        name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access for this site in the browser settings, then try again.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : name === 'NotReadableError'
              ? 'The camera is being used by another app. Close it and try again.'
              : `The camera couldn’t start (${name || 'unknown error'}).`,
      );
      setPhase('camera-error');
    }
  }, [flush, requestWakeLock]);

  // Sampling loop, heartbeat, and keeping the screen awake while watching.
  useEffect(() => {
    if (phase !== 'watching') return;
    const ctx = canvasRef.current!.getContext('2d', { willReadFrequently: true })!;
    const sample = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      ctx.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
      const gray = toGray(ctx.getImageData(0, 0, FRAME_WIDTH, FRAME_HEIGHT).data);
      const now = Date.now();
      const u = detector.current.update(gray, now);
      setLevel(u.fraction);
      setDark(u.dark);
      if (u.moving) setLastMotion(now);
      if (u.report) {
        queue.current.push(now);
        saveQueue();
        void flush();
      }
    }, SAMPLE_MS);
    const heartbeat = setInterval(() => void flush(), HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    const onOnline = () => void flush();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(sample);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [phase, flush, requestWakeLock]);

  const changeSensitivity = (s: Sensitivity) => {
    setSensitivity(s);
    detector.current.sensitivity = s;
    store.set(SENS_STORE, s);
  };

  const threshold = SENSITIVITY_FRACTION[sensitivity];

  return (
    <div className="sensor-page">
      <section className="card stack sensor-card">
        <div className="spread">
          <h1>{deviceName ?? 'Webcam sensor'}</h1>
          {phase === 'watching' && (
            <span className={`status-pill ${offline ? 'status-watch' : 'status-ok'}`}>
              <span className="dot" aria-hidden />
              {offline ? 'Offline, will resend' : 'Watching'}
            </span>
          )}
        </div>

        {phase === 'loading' && <p className="muted">Loading…</p>}

        {phase === 'need-key' && (
          <p className="notice error">
            This page needs its setup link. On the check-in dashboard, go to <strong>Set up → Webcams</strong> and open the
            link (or scan the QR code) on this device.
          </p>
        )}

        {phase === 'insecure' && (
          <p className="notice error">
            This browser only allows camera access on secure (https) pages or on the computer running the app. Open the
            sensor link through a secure address, or use this page on that computer.
          </p>
        )}

        {phase === 'revoked' && (
          <p className="notice error">
            This link was replaced or the webcam was removed. Get a new link from <strong>Set up → Webcams</strong>.
          </p>
        )}

        {(phase === 'ready' || phase === 'starting' || phase === 'camera-error') && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              This device will watch for movement. Video stays on this device: only the times of movement are sent, never
              pictures.
            </p>
            {phase === 'camera-error' && <p className="notice error">{cameraError}</p>}
            <div>
              <button className="button" type="button" onClick={start} disabled={phase === 'starting'}>
                {phase === 'starting' ? 'Starting camera…' : phase === 'camera-error' ? 'Try again' : 'Start watching'}
              </button>
            </div>
          </>
        )}

        <div className={phase === 'watching' ? 'sensor-live' : 'sensor-hidden'}>
          <div className={`sensor-video${preview ? '' : ' sensor-video-off'}`}>
            <video ref={videoRef} muted playsInline aria-label="Camera preview, shown only on this device" />
            {!preview && <span className="subtle">Preview hidden. Still watching.</span>}
          </div>
          <canvas ref={canvasRef} width={FRAME_WIDTH} height={FRAME_HEIGHT} hidden />

          <div className="meter" aria-label="Movement level">
            <div className="meter-fill" style={{ width: `${Math.min(100, (level / (threshold * 3)) * 100)}%` }} />
            <div className="meter-mark" style={{ left: '33.3%' }} title="Counts as movement above this line" />
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-label">Last movement</div>
              <div className="stat-value">{lastMotion ? fmt(lastMotion) : '—'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Last check-in</div>
              <div className="stat-value">{lastSync ? fmt(lastSync) : '—'}</div>
              {queued > 0 && <div className="subtle">{queued} waiting to send</div>}
            </div>
          </div>

          {dark && <p className="notice">It&apos;s too dark for the camera to see movement. Mornings work once lights are on.</p>}

          <div className="row">
            <label className="subtle" htmlFor="sens">
              Sensitivity
            </label>
            <select id="sens" className="input-small" value={sensitivity} onChange={(e) => changeSensitivity(e.target.value as Sensitivity)}>
              <option value="low">Low (fewer false triggers)</option>
              <option value="medium">Medium</option>
              <option value="high">High (small movements)</option>
            </select>
            <button className="button secondary small" type="button" onClick={() => setPreview((p) => !p)}>
              {preview ? 'Hide preview' : 'Show preview'}
            </button>
          </div>
          <p className="subtle" style={{ margin: 0 }}>
            Keep this page open and the device plugged in. The screen stays on while watching.
          </p>
        </div>
      </section>
    </div>
  );
}
