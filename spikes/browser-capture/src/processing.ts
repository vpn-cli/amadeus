export function isAudioProcessingEnabled(search: string): boolean {
  return new URLSearchParams(search).get("processing") !== "off";
}

export interface ReportedTrackSettings {
  echoCancellation: string;
  noiseSuppression: string;
  autoGainControl: string;
  channelCount: string;
  sampleRate: string;
}

export function formatReportedTrackSettings(
  settings: MediaTrackSettings | undefined,
): ReportedTrackSettings {
  return {
    echoCancellation:
      settings?.echoCancellation !== undefined ? String(settings.echoCancellation) : "n/a",
    noiseSuppression:
      settings?.noiseSuppression !== undefined ? String(settings.noiseSuppression) : "n/a",
    autoGainControl:
      settings?.autoGainControl !== undefined ? String(settings.autoGainControl) : "n/a",
    channelCount:
      settings?.channelCount !== undefined ? String(settings.channelCount) : "n/a",
    sampleRate:
      settings?.sampleRate !== undefined ? `${settings.sampleRate} Hz` : "n/a",
  };
}
