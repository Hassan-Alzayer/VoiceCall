export interface ScoreMsg {
  type: "score";
  text: string;
  window: string;
  score: number;
  ts: number;
}
export interface ScamMsg {
  type: "scam_detected";
  score: number;
}

export const openScamWs = (url = "ws://localhost:8000/ws/audio") =>
  new WebSocket(url);