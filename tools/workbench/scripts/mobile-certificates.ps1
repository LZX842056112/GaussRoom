param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$AddressesBase64,
    [Parameter(Mandatory=$true)][long]$Now
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-SafePath([string]$Path, [bool]$InsideRoot = $true) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full -notmatch '^[A-Za-z]:\\' -or $full -eq [System.IO.Path]::GetPathRoot($full)) { throw 'Unsafe directory' }
    if ($InsideRoot -and $full -ne $script:privateRoot -and -not $full.StartsWith($script:privateRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe child path' }
    $part = $full
    while ($part) {
        if ([System.IO.File]::Exists($part) -or [System.IO.Directory]::Exists($part)) {
            if (([System.IO.File]::GetAttributes($part) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed' }
        }
        $parent = [System.IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }
        $part = $parent
    }
    return $full
}

function Protect-PrivatePath([string]$Path, [bool]$Directory) {
    $safe = Assert-SafePath $Path
    $acl = if ($Directory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $inherit = if ($Directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @($identity, $system)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    if ($Directory) { [System.IO.Directory]::SetAccessControl($safe, $acl) }
    else { [System.IO.File]::SetAccessControl($safe, $acl) }
}

$candidate = $null
$ca = $null
$caKey = $null
$leafKey = $null
$leaf = $null
$signed = $null
$publicCa = $null
try {
    $script:privateRoot = Assert-SafePath $Root $false
    [void][System.IO.Directory]::CreateDirectory($script:privateRoot)
    Protect-PrivatePath $script:privateRoot $true
    $currentPath = Assert-SafePath ([System.IO.Path]::Combine($script:privateRoot, 'current.json'))
    $addresses = [string[]](ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AddressesBase64))))
    if ($addresses.Count -lt 1 -or $addresses.Count -gt 256) { throw 'Invalid addresses' }
    foreach ($address in $addresses) {
        $ip = [System.Net.IPAddress]::Parse($address)
        if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $address -notmatch '^(127\.0\.0\.1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)') { throw 'Invalid address' }
    }
    $instant = [DateTimeOffset]::FromUnixTimeMilliseconds($Now)
    $existing = $null
    if ([System.IO.File]::Exists($currentPath)) {
        Protect-PrivatePath $currentPath $false
        $existing = ConvertFrom-Json ([System.IO.File]::ReadAllText($currentPath))
        $sameAddresses = (($existing.addresses | Sort-Object) -join ',') -eq (($addresses | Sort-Object) -join ',')
        if ($sameAddresses -and ([DateTimeOffset]::Parse($existing.expiresAt) - $instant).TotalDays -ge 14) { exit 0 }
    }
    $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    $password = if ($existing) { $existing.passphrase } else { [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N') }
    $profileId = if ($existing) { $existing.profileId } else { [Guid]::NewGuid().ToString() }
    $caPayloadId = if ($existing) { $existing.caPayloadId } else { [Guid]::NewGuid().ToString() }
    $caBytes = $null
    if ($existing) {
        $caBytes = [Convert]::FromBase64String($existing.caPfx)
        $ca = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($caBytes, $password, $flags)
    }
    if (-not $ca -or $ca.NotAfter.ToUniversalTime() -le $instant.AddDays(91).UtcDateTime) {
        if ($ca) { $ca.Dispose() }
        $caKey = [System.Security.Cryptography.RSA]::Create(3072)
        $caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=GaussRoom Camera Root CA', $caKey, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))
        $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]'KeyCertSign, CrlSign', $true))
        $caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
        $ca = $caRequest.CreateSelfSigned($instant.AddMinutes(-5), $instant.AddYears(5))
        $caBytes = $ca.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
        $profileId = [Guid]::NewGuid().ToString()
        $caPayloadId = [Guid]::NewGuid().ToString()
    }
    $leafKey = [System.Security.Cryptography.RSA]::Create(2048)
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=GaussRoom Camera', $leafKey, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]'DigitalSignature, KeyEncipherment', $true))
    $eku = [System.Security.Cryptography.OidCollection]::new()
    [void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('localhost')
    foreach ($address in $addresses) { $san.AddIpAddress([System.Net.IPAddress]::Parse($address)) }
    $request.CertificateExtensions.Add($san.Build())
    $serial = New-Object byte[] 16
    $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($serial) } finally { $random.Dispose() }
    $serial[0] = $serial[0] -band 127
    $signed = $request.Create($ca, $instant.AddMinutes(-5), $instant.AddDays(90), $serial)
    $leaf = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($signed, $leafKey)
    $publicCa = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($ca.RawData)
    $collection = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
    [void]$collection.Add($leaf)
    [void]$collection.Add($publicCa)
    $bundle = [ordered]@{
        version = 1
        addresses = $addresses
        expiresAt = $leaf.NotAfter.ToUniversalTime().ToString('o')
        caExpiresAt = $ca.NotAfter.ToUniversalTime().ToString('o')
        passphrase = $password
        caPfx = [Convert]::ToBase64String($caBytes)
        pfx = [Convert]::ToBase64String($collection.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password))
        caDer = [Convert]::ToBase64String($ca.RawData)
        leafDer = [Convert]::ToBase64String($leaf.RawData)
        profileId = $profileId
        caPayloadId = $caPayloadId
    }
    $candidate = Assert-SafePath ([System.IO.Path]::Combine($script:privateRoot, 'candidate-' + [Guid]::NewGuid().ToString('N') + '.json'))
    [System.IO.File]::WriteAllText($candidate, (ConvertTo-Json -InputObject $bundle -Depth 4 -Compress), [System.Text.UTF8Encoding]::new($false))
    Protect-PrivatePath $candidate $false
    [void](Assert-SafePath $currentPath)
    if ([System.IO.File]::Exists($currentPath)) { [System.IO.File]::Replace($candidate, $currentPath, [System.Management.Automation.Language.NullString]::Value) }
    else { [System.IO.File]::Move($candidate, $currentPath) }
    $candidate = $null
} catch {
    # Do not include native errors. They can contain private paths or PFX data.
    [Console]::Error.WriteLine('Certificate preparation failed at line ' + $_.InvocationInfo.ScriptLineNumber + ' (' + $_.Exception.GetType().Name + ')')
    exit 1
} finally {
    if ($candidate -and [System.IO.File]::Exists($candidate)) { [System.IO.File]::Delete((Assert-SafePath $candidate)) }
    foreach ($item in @($leaf, $signed, $publicCa, $ca, $leafKey, $caKey)) { if ($item) { $item.Dispose() } }
}
