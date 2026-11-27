$ErrorActionPreference = "Stop"

$TARGET_SAMPLE_RATE = 16000
# Amplitude threshold used to trim leading/trailing near-silence before concatenation:
# -50 dBFS => 32768 * 10^(-50 / 20) = 103.62 => 104 in signed 16-bit PCM
$TRIM_THRESHOLD_DBFS = -50.0
$TRIM_THRESHOLD_INT16 = [int][math]::Round(32768 * [math]::Pow(10.0, $TRIM_THRESHOLD_DBFS / 20.0))

$LEAD_SILENCE_S = 1.0
$GAP_SILENCE_S = 1.2
$TRAIL_SILENCE_S = 1.0

$outDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$utt1Text = "Hello, can you check the status of order one zero four two?"
$utt2Text = "Thanks, what time is it right now?"

$raw1 = Join-Path $outDir "utt1.raw.wav"
$raw2 = Join-Path $outDir "utt2.raw.wav"
$pcm1 = Join-Path $outDir "utt1.16k.wav"
$pcm2 = Join-Path $outDir "utt2.16k.wav"
$trim1 = Join-Path $outDir "utt1.trimmed.wav"
$trim2 = Join-Path $outDir "utt2.trimmed.wav"
$finalWav = Join-Path $outDir "sample-16k.wav"
$labelsFile = Join-Path $outDir "sample-16k.labels.txt"

function Invoke-Ffmpeg {
    param([string[]]$Arguments)
    $prevErrPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & ffmpeg @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevErrPref
    }
    if ($exitCode -ne 0) {
        throw "ffmpeg failed with exit code $exitCode"
    }
}

function Trim-Pcm16Silence {
    param(
        [string]$InputPath,
        [string]$OutputPath,
        [int]$ThresholdInt16,
        [int]$ExpectedSampleRate
    )

    $bytes = [System.IO.File]::ReadAllBytes($InputPath)
    if ($bytes.Length -lt 44) {
        throw "WAV file too short: $InputPath"
    }

    $offset = 12
    $audioFormat = 0
    $channels = 0
    $sampleRate = 0
    $bitsPerSample = 0
    $dataStart = -1
    $dataLength = 0

    while ($offset + 8 -le $bytes.Length) {
        $chunkId = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
        $chunkSize = [int][BitConverter]::ToUInt32($bytes, $offset + 4)
        $bodyStart = $offset + 8

        if ($chunkId -eq "fmt ") {
            $audioFormat = [int][BitConverter]::ToUInt16($bytes, $bodyStart)
            $channels = [int][BitConverter]::ToUInt16($bytes, $bodyStart + 2)
            $sampleRate = [int][BitConverter]::ToUInt32($bytes, $bodyStart + 4)
            $bitsPerSample = [int][BitConverter]::ToUInt16($bytes, $bodyStart + 14)
        }
        elseif ($chunkId -eq "data") {
            $dataStart = $bodyStart
            $dataLength = $chunkSize
            break
        }

        $offset = $bodyStart + $chunkSize + ($chunkSize % 2)
    }

    if ($audioFormat -ne 1 -or $channels -ne 1 -or $sampleRate -ne $ExpectedSampleRate -or $bitsPerSample -ne 16) {
        throw "Expected PCM16 mono ${ExpectedSampleRate}Hz WAV in $InputPath, got fmt=$audioFormat ch=$channels sr=$sampleRate bits=$bitsPerSample"
    }
    if ($dataStart -lt 0 -or ($dataStart + $dataLength) -gt $bytes.Length) {
        throw "Missing or truncated data chunk in $InputPath"
    }

    $sampleCount = [int]($dataLength / 2)
    $firstNonSilent = -1
    $lastNonSilent = -1

    for ($i = 0; $i -lt $sampleCount; $i++) {
        $sample = [int][BitConverter]::ToInt16($bytes, $dataStart + ($i * 2))
        if ([math]::Abs($sample) -ge $ThresholdInt16) {
            if ($firstNonSilent -lt 0) {
                $firstNonSilent = $i
            }
            $lastNonSilent = $i
        }
    }

    if ($firstNonSilent -lt 0) {
        throw "No samples exceeded threshold $ThresholdInt16 in $InputPath"
    }

    $trimmedSamples = $lastNonSilent - $firstNonSilent + 1
    $trimmedBytesLen = $trimmedSamples * 2
    $outBytes = New-Object byte[] (44 + $trimmedBytesLen)

    $bw = New-Object System.IO.BinaryWriter (New-Object System.IO.MemoryStream (,$outBytes))
    try {
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes("RIFF"))
        $bw.Write([uint32](36 + $trimmedBytesLen))
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes("WAVE"))
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes("fmt "))
        $bw.Write([uint32]16)
        $bw.Write([uint16]1)
        $bw.Write([uint16]1)
        $bw.Write([uint32]$ExpectedSampleRate)
        $bw.Write([uint32]($ExpectedSampleRate * 2))
        $bw.Write([uint16]2)
        $bw.Write([uint16]16)
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes("data"))
        $bw.Write([uint32]$trimmedBytesLen)
        $bw.Write($bytes, $dataStart + ($firstNonSilent * 2), $trimmedBytesLen)
    }
    finally {
        $bw.Dispose()
    }

    [System.IO.File]::WriteAllBytes($OutputPath, $outBytes)

    return @{
        TotalSamples   = $sampleCount
        FirstSample    = $firstNonSilent
        LastSample     = $lastNonSilent
        TrimmedSamples = $trimmedSamples
    }
}

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0

try {
    $synth.SetOutputToWaveFile($raw1)
    $synth.Speak($utt1Text)

    $synth.SetOutputToWaveFile($raw2)
    $synth.Speak($utt2Text)
}
finally {
    $synth.SetOutputToNull()
    $synth.Dispose()
}

# Resample synthesized clips to 16 kHz mono PCM16LE first, then trim leading/trailing near-silence BEFORE concatenation
Invoke-Ffmpeg @("-y", "-loglevel", "error", "-i", $raw1, "-ac", "1", "-ar", "$TARGET_SAMPLE_RATE", "-sample_fmt", "s16", $pcm1)
Invoke-Ffmpeg @("-y", "-loglevel", "error", "-i", $raw2, "-ac", "1", "-ar", "$TARGET_SAMPLE_RATE", "-sample_fmt", "s16", $pcm2)

$info1 = Trim-Pcm16Silence -InputPath $pcm1 -OutputPath $trim1 -ThresholdInt16 $TRIM_THRESHOLD_INT16 -ExpectedSampleRate $TARGET_SAMPLE_RATE
$info2 = Trim-Pcm16Silence -InputPath $pcm2 -OutputPath $trim2 -ThresholdInt16 $TRIM_THRESHOLD_INT16 -ExpectedSampleRate $TARGET_SAMPLE_RATE

# Build: 1.0s silence -> trimmed utt1 -> 1.2s silence -> trimmed utt2 -> 1.0s silence, 16kHz mono PCM16LE
Invoke-Ffmpeg @(
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-t", "$LEAD_SILENCE_S", "-i", "anullsrc=r=${TARGET_SAMPLE_RATE}:cl=mono",
    "-i", $trim1,
    "-f", "lavfi", "-t", "$GAP_SILENCE_S", "-i", "anullsrc=r=${TARGET_SAMPLE_RATE}:cl=mono",
    "-i", $trim2,
    "-f", "lavfi", "-t", "$TRAIL_SILENCE_S", "-i", "anullsrc=r=${TARGET_SAMPLE_RATE}:cl=mono",
    "-filter_complex", "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1,aformat=sample_fmts=s16:channel_layouts=mono[out]",
    "-map", "[out]", "-ac", "1", "-ar", "$TARGET_SAMPLE_RATE", "-sample_fmt", "s16", $finalWav
)

$total = [double](ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $finalWav)

Remove-Item -Force $raw1, $raw2, $pcm1, $pcm2, $trim1, $trim2

$inv = [System.Globalization.CultureInfo]::InvariantCulture
$leadSamples = [int][math]::Round($LEAD_SILENCE_S * $TARGET_SAMPLE_RATE)
$gapSamples = [int][math]::Round($GAP_SILENCE_S * $TARGET_SAMPLE_RATE)

$u1StartSamples = $leadSamples
$u1EndSamples = $u1StartSamples + $info1.TrimmedSamples
$u2StartSamples = $u1EndSamples + $gapSamples
$u2EndSamples = $u2StartSamples + $info2.TrimmedSamples

$u1StartStr = [string]::Format($inv, "{0:F3}", $u1StartSamples / [double]$TARGET_SAMPLE_RATE)
$u1EndStr = [string]::Format($inv, "{0:F3}", $u1EndSamples / [double]$TARGET_SAMPLE_RATE)
$u2StartStr = [string]::Format($inv, "{0:F3}", $u2StartSamples / [double]$TARGET_SAMPLE_RATE)
$u2EndStr = [string]::Format($inv, "{0:F3}", $u2EndSamples / [double]$TARGET_SAMPLE_RATE)

$labelLines = @(
    "# Ground-truth speech intervals for sample-16k.wav"
    "# Trimmed each TTS clip before concatenation at |x| < $TRIM_THRESHOLD_DBFS dBFS (int16 threshold $TRIM_THRESHOLD_INT16 at $TARGET_SAMPLE_RATE Hz)"
    "${u1StartStr}`t${u1EndStr}`t${utt1Text}"
    "${u2StartStr}`t${u2EndStr}`t${utt2Text}"
)
[System.IO.File]::WriteAllLines($labelsFile, $labelLines, [System.Text.UTF8Encoding]::new($false))

Write-Host "Generated $finalWav (total: $([string]::Format($inv, '{0:F3}', $total)) s, 16kHz mono PCM16LE)"
Write-Host "Trim threshold: $TRIM_THRESHOLD_DBFS dBFS (|sample| >= $TRIM_THRESHOLD_INT16)"
Write-Host "Utterance 1 trimmed: removed $($info1.FirstSample) lead / $($info1.TotalSamples - $info1.LastSample - 1) trail samples -> ${u1StartStr}s .. ${u1EndStr}s"
Write-Host "Utterance 2 trimmed: removed $($info2.FirstSample) lead / $($info2.TotalSamples - $info2.LastSample - 1) trail samples -> ${u2StartStr}s .. ${u2EndStr}s"
Write-Host "Wrote labels: $labelsFile"
