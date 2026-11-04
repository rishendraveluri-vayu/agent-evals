import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import { errorText } from '../api/errors';

export interface Loaded<T> {
  data: ShallowRef<T | null>;
  error: Ref<string | null>;
  loading: Ref<boolean>;
  reload: () => Promise<void>;
}

/** Runs a load now and keeps its result, its error in words, and whether it is running. */
export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
  const data = shallowRef<T | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(true);
  const reload = async () => {
    loading.value = true;
    try {
      data.value = await load();
      error.value = null;
    } catch (err) {
      error.value = errorText(err);
    } finally {
      loading.value = false;
    }
  };
  void reload();
  return { data, error, loading, reload };
}

/** Swallows a failed optional load: the screen shows what it has without it. */
export async function optional<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}
