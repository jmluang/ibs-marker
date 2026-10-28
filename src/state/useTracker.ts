import { useSyncExternalStore } from "react";
import { trackerStore, type TrackerStore } from "./TrackerStore";
export const useTracker = (store: TrackerStore = trackerStore) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
