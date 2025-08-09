#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'yaml'
require 'date'

ROOT = File.expand_path('..', __dir__)
POSTS_DIR = File.join(ROOT, '_posts')
CATE_DIR  = File.join(ROOT, 'categories')

paths = []
Dir.glob(File.join(POSTS_DIR, '*.md')).each do |file|
  content = File.read(file)
  # extract YAML front matter
  if content =~ /^---\s*\n(.*?)\n---/m
    begin
      fm = YAML.safe_load($1, permitted_classes: [Date], aliases: true) || {}
    rescue => e
      warn "skip #{file}: #{e.message}"
      next
    end
    cats = fm['categories'] || []
    cats = [cats].flatten.compact.map { |c| c.to_s.strip }.reject(&:empty?)
    next if cats.empty?
    (1..cats.length).each do |i|
      paths << cats.first(i).join('/')
    end
  end
end

paths.uniq!
FileUtils.mkdir_p(CATE_DIR)

paths.each do |path|
  dir = File.join(CATE_DIR, path)
  FileUtils.mkdir_p(dir)
  index = File.join(dir, 'index.md')
  unless File.exist?(index)
    File.write(index, <<~MD)
    ---
    layout: category
    category: #{path}
    ---
    MD
    puts "created: #{index}"
  end
end

puts "done. #{paths.size} category pages ensured."
