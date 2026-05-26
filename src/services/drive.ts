/**
 * Service for interacting with Google Drive API
 */

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export class GoogleDriveService {
  private accessToken: string;
  private folderId: string | null = null;
  private FOLDER_NAME = 'LG13_Terminal_Data';

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async fetch(url: string, options: RequestInit = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `Drive API error: ${response.status}`);
    }

    return response;
  }

  async getAppFolder(): Promise<string> {
    if (this.folderId) return this.folderId;

    const query = encodeURIComponent(`name = '${this.FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const response = await this.fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`);
    const data = await response.json();

    if (data.files && data.files.length > 0) {
      this.folderId = data.files[0].id;
      return this.folderId!;
    }

    // Create folder if not exists
    const createResponse = await this.fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: this.FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    const folder = await createResponse.json();
    this.folderId = folder.id;
    return this.folderId!;
  }

  async uploadFile(name: string, content: string, metadata: any = {}): Promise<GDriveFile> {
    const folderId = await this.getAppFolder();
    
    // Check if file exists to decide whether to create or update
    const query = encodeURIComponent(`name = '${name}' and '${folderId}' in parents and trashed = false`);
    const searchResponse = await this.fetch(`https://www.googleapis.com/drive/v3/files?q=${query}`);
    const searchData = await searchResponse.json();
    
    const fileMetadata: any = {
      name,
      parents: [folderId],
      appProperties: metadata
    };

    if (searchData.files && searchData.files.length > 0) {
      // Update existing
      const existingId = searchData.files[0].id;
      
      // Update metadata first (appProperties)
      await this.fetch(`https://www.googleapis.com/drive/v3/files/${existingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appProperties: metadata }),
      });

      // Then update content
      const response = await this.fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
        method: 'PATCH',
        body: content,
      });
      return await response.json();
    }

    // New file (Multipart upload for metadata + content)
    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const multipartRequestBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(fileMetadata) +
        delimiter +
        'Content-Type: text/plain\r\n\r\n' +
        content +
        close_delim;

    const response = await this.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });

    return await response.json();
  }

  async getAbout(): Promise<any> {
    const response = await this.fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota,user');
    return await response.json();
  }

  async listFiles(): Promise<GDriveFile[]> {
    const folderId = await this.getAppFolder();
    const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const response = await this.fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id, name, mimeType, appProperties)`);
    const data = await response.json();
    return data.files || [];
  }

  async getFileContent(fileId: string): Promise<string> {
    const response = await this.fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return await response.text();
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
    });
  }
}
