export interface Position {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface Participant {
  id: string;
  name: string;
  color: number;
  sharing: boolean;
  online: boolean;
  lastSeen: number;
  location: Position | null;
}

export interface SessionSnapshot {
  id: string;
  createdAt: number;
  expiresAt: number;
  viewerId: string | null;
  participants: Participant[];
}

export interface MapConfig {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
}
