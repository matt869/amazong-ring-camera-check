import type { Metadata } from 'next';
import WebcamSensor from '@/components/WebcamSensor';

export const metadata: Metadata = { title: 'Webcam sensor' };

/** Opened on the device at the resident's home. Public: it authenticates with its own key. */
export default function SensorPage() {
  return <WebcamSensor />;
}
