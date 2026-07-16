import { safeStorage } from "electron";

export class ProtectedCredentialService {
  encrypt(secret: string): Uint8Array {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-protected credential storage is unavailable");
    }
    return safeStorage.encryptString(secret);
  }

  decrypt(encrypted: Uint8Array): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-protected credential storage is unavailable");
    }
    return safeStorage.decryptString(Buffer.from(encrypted));
  }
}
