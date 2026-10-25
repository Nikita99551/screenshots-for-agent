param([Parameter(Mandatory = $true)][string]$Manifest)

# Кладёт в буфер обмена одновременно список файлов (CF_HDROP) и текст.
# Требует STA: запускать как powershell -STA -File copy-to-clipboard.ps1 -Manifest clip.json
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$json = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json

$data = New-Object System.Windows.Forms.DataObject
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($f in @($json.files)) { if ($f) { [void]$files.Add([string]$f) } }
if ($files.Count -gt 0) { $data.SetFileDropList($files) }
if ($json.text) { $data.SetText([string]$json.text, [System.Windows.Forms.TextDataFormat]::UnicodeText) }

try {
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 20, 100)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
