export type Resource = {
  id: string; folderId: string | null; ownerId: string; name: string; sizeBytes: string;
  uploaderName: string; ownerName: string; sha256: string; availability: string;
  updatedAt: string; uploadedAt: string; createdAt: string; downloadUrl: string;
  currentVersionId: string; revision: number; extension: string;
};
export type Folder = { id: string; parentId: string | null; ownerId: string; name: string; revision: number };
export type Transfer = { id: string; resourceId: string; name: string; fingerprint: string; sizeBytes: string; receivedBytes: string; state: string; errorCode: string | null; uploadUrl: string };
export type Profile = { kind: string; id: string; name: string; subject: string; capabilities: string[]; csrfToken: string };
