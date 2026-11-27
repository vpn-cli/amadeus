$ErrorActionPreference = "Stop"

$outDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$raw1 = Join-Path $outDir "utt1.raw.wav"
$raw2 = Join-Path $outDir "utt2.raw.wav"
$finalWav = Join-Path $outDir "sample-16k.wav"

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0

try {
    $synth.SetOutputToWaveFile($raw1)
    $synth.Speak("Hello, can you check the status of order one zero four two?")

    $synth.SetOutputToWaveFile($raw2)
    $synth.Speak("Thanks, what time is it right now?")
}
finally {
    $synth.SetOutputToNull()
    $synth.Dispose()
}

# Build: 1.0s silence -> utt1 -> 1.2s silence -> utt2 -> 1.0s silence, 16kHz mono PCM16LE
$prevErrPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& ffmpeg -y -loglevel error `
    -f lavfi -t 1.0 -i "anullsrc=r=16000:cl=mono" `
    -i $raw1 `
    -f lavfi -t 1.2 -i "anullsrc=r=16000:cl=mono" `
    -i $raw2 `
    -f lavfi -t 1.0 -i "anullsrc=r=16000:cl=mono" `
    -filter_complex "[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1,aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono[out]" `
    -map "[out]" -ac 1 -ar 16000 -sample_fmt s16 $finalWav
$ffmpegExit = $LASTEXITCODE
$ErrorActionPreference = $prevErrPref

if ($ffmpegExit -ne 0) {
    throw "ffmpeg failed with exit code $ffmpegExit"
}

$d1 = [double](ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $raw1)
$d2 = [double](ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $raw2)
$total = [double](ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $finalWav)

Remove-Item -Force $raw1, $raw2

$u1Start = 1.0
$u1End = [math]::Round($u1Start + $d1, 3)
$u2Start = [math]::Round($u1End + 1.2, 3)
$u2End = [math]::Round($u2Start + $d2, 3)

Write-Host "Generated $finalWav (total: $([math]::Round($total, 3)) s, 16kHz mono PCM16LE)"
Write-Host "Ground truth utterance 1: ${u1Start}s .. ${u1End}s"
Write-Host "Ground truth utterance 2: ${u2Start}s .. ${u2End}s"
