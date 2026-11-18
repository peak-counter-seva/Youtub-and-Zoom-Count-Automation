import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";
import { firebaseConfig } from "../firebaseConfig";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Optional settings left empty (e.g. a stream using the default interval) are simply not saved.
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export const googleProvider = new GoogleAuthProvider();
