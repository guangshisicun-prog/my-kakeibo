#!/usr/bin/perl
# テスト用の小さなサーバー。このMacの中だけ（127.0.0.1）でファイルを配る。
# つかい方: perl tests/server.pl 8765 .
use strict;
use warnings;
use IO::Socket::INET;

my $port = shift || 8765;
my $root = shift || '.';
my %types = (
  html => 'text/html; charset=utf-8',
  js   => 'text/javascript; charset=utf-8',
  json => 'application/json; charset=utf-8',
  css  => 'text/css; charset=utf-8',
  png  => 'image/png',
  svg  => 'image/svg+xml',
);

my $server = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1', LocalPort => $port, Listen => 10, ReuseAddr => 1,
) or die "サーバーを起動できませんでした: $!\n";
$| = 1;
print "http://localhost:$port/tests/test.html\n";

while (my $c = $server->accept) {
  my $req = <$c> // '';
  while (my $line = <$c>) { last if $line =~ /^\r?\n$/; }
  my ($path) = $req =~ m{^GET\s+(\S+)};
  $path //= '/';
  $path =~ s/\?.*//;
  $path =~ s/%([0-9A-Fa-f]{2})/chr hex $1/ge;
  $path .= 'index.html' if $path =~ m{/$};
  my $file = "$root$path";
  if ($path !~ /\.\./ && -f $file && open(my $fh, '<:raw', $file)) {
    local $/;
    my $body = <$fh>;
    close $fh;
    my ($ext) = $file =~ /\.(\w+)$/;
    my $type = $types{lc($ext // '')} || 'application/octet-stream';
    print $c "HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: " . length($body)
      . "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n$body";
  } else {
    print $c "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found";
  }
  close $c;
}
