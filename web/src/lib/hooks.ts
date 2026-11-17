import { useEffect, useState } from "react";
import {
  collection, doc, limit, onSnapshot, orderBy, query, type DocumentData,
} from "firebase/firestore";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth, db } from "./firebase";

export function useUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

export function useCollection<T>(path: string, order?: string, max = 100) {
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ref = collection(db, path);
    const q = order ? query(ref, orderBy(order, "desc"), limit(max)) : query(ref, limit(max));
    return onSnapshot(
      q,
      (s) => setItems(s.docs.map((d) => ({ id: d.id, ...(d.data() as DocumentData) }) as T)),
      (e) => setError(e.message),
    );
  }, [path, order, max]);
  return { items, error };
}

export function useDocument<T>(path: string, id: string | null) {
  const [data, setData] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    return onSnapshot(
      doc(db, path, id),
      (s) => setData(s.exists() ? ({ id: s.id, ...s.data() } as T) : null),
      () => setData(null),
    );
  }, [path, id]);
  return data;
}
