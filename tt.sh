apt update && apt upgrade -y
apt install -y git cmake build-essential libuv1-dev libssl-dev libhwloc-dev
pkg install git
pkg install cmake
git clone https://github.com/xmrig/xmrig.git
cd xmrig && mkdir build && cd build
cmake ..
make -j$(nproc)
cd ~
rm -rf xmrig
git clone https://github.com/xmrig/xmrig.git
cd xmrig
mkdir build
cd build
cmake .. -DWITH_HWLOC=OFF
make -j$(nproc)
./xmrig -a rx/0 \
  -o stratum+tcp://zeph.2miners.com:2222 \
  -u ZEPHYR2XeiFAkpJC4yaZYFPYe7ony9tJpjGKMowFz1cVU4czwRZrSvp5a1czjQMEU1dXDW9oKk7NK3DiJ8rNgxNZRLMrq8Li4Xe3Y.WOgggg \
  -p x
