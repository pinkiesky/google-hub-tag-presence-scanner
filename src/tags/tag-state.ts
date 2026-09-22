// Timestamps are stored as UTC Unix seconds.
export interface TagState {
  tag_id: string;
  name: string;
  created_at: number;
  last_seen: number | null;
}
