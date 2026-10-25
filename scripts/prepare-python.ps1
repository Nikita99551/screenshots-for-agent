# Готовит встраиваемый Python 3.12 с библиотеками распознавания речи в build/python
# (эта папка целиком попадает в установщик). Нужен установленный Python 3.12 (py -3.12) только для pip.
# Запуск: npm run python
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $root 'build\python'
$zip = Join-Path $root 'build\python-embed.zip'
$ver = '3.12.10'

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$ver/python-$ver-embed-amd64.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dst -Force
Remove-Item $zip

# встраиваемый Python видит только пути из ._pth — добавляем папку библиотек
Set-Content -Path (Join-Path $dst 'python312._pth') -Value "python312.zip`r`n.`r`nLib\site-packages" -NoNewline -Encoding ascii

py -3.12 -m pip install --disable-pip-version-check --target (Join-Path $dst 'Lib\site-packages') "onnx-asr[cpu,hub]" numpy
Write-Host "Готово: $dst"
