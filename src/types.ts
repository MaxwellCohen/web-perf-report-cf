/**
 * Type definitions for the PageSpeed reporting system
 */

export type FormFactor = "DESKTOP" | "MOBILE";

export type RecordStatus = "pending" | "processing" | "completed" | "failed";

export interface PageSpeedRecord {
  id: number;
  publicId: string;
  url: string;
  formFactor: string;
  date: number;
  data: any;
  status: RecordStatus;
  dataUrl: string;
}

export interface CreateRecordRequest {
  requestUrl: string;
  formFactor: string;
  status: RecordStatus;
  data: any;
}

export interface UpdateRecordRequest {
  id: number;
  publicId?: string;
  status: RecordStatus;
  data: any;
  dataUrl: string;
  processingStartedAt?: number | null;
}

export interface PageSpeedApiResponse {
  error?: string;
  [key: string]: any;
}

export interface RecordResponse {
  publicId: string;
  url: string;
  status: string;
  dataUrl: string;
  data: any;
}
