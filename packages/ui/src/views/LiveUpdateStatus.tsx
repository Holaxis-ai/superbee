import { useSyncExternalStore } from "react";
import { getStreamStatus, subscribeToStreamStatus } from "../pages/pageEvents.js";

export function LiveUpdateStatus() {
  const status = useSyncExternalStore(subscribeToStreamStatus, getStreamStatus, getStreamStatus);
  if (status !== "disconnected") return null;
  return <p role="status" className="live-update-status">Live updates are disconnected in this tab. Refresh the page when you need current information.</p>;
}
