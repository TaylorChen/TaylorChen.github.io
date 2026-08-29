#!/bin/bash
# 系统自带 ruby 是 2.6，跑不了 Jekyll 4.4（需要 3.0+）。
# Homebrew 的 ruby 是 keg-only 且未 link，所以这里手动把它挪到 PATH 最前面。
if [ -d /opt/homebrew/opt/ruby/bin ]; then
  export PATH="/opt/homebrew/opt/ruby/bin:$PATH"
fi
bundle exec jekyll serve
