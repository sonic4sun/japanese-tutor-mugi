# 等本機 3004 埠開起來。成功 exit 0，逾時 exit 1。
param([int]$Seconds = 60, [int]$Port = 3004)
for ($i = 0; $i -lt $Seconds; $i++) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $Port)
    $c.Close()
    exit 0
  } catch {
    Start-Sleep -Seconds 1
  }
}
exit 1
