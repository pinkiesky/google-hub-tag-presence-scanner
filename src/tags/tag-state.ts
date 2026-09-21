// Timestamps are stored as UTC Unix seconds.
export interface TagState {
  tag_id: string;
  name: string;
  created_at: number;
  last_seen: number | null;
  last_rssi: number | null;
  alert_sent: boolean;
  missing_since: number | null;
  episode: number;
}
export interface Notification {
  id: number;
  tag_id: string;
  episode: number;
  kind: 'absence' | 'recovery';
  message: string;
  attempts: number;
}
