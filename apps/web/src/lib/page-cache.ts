/**
 * 화면을 옮겨 다닐 때 직전에 받은 데이터를 바로 보여 주기 위한 메모리 캐시.
 * 화면은 캐시된 값을 먼저 그리고, 곧바로 서버에서 다시 읽어 바꿔 끼운다(오래된 값을 사실처럼 오래 두지 않는다).
 * 탭을 새로 고치면 비워진다. 저장소(localStorage)에는 쓰지 않는다.
 */
const store = new Map<string, unknown>();

export function readCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function writeCache<T>(key: string, value: T): void {
  store.set(key, value);
}
