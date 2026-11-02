<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
require_once($CFG->dirroot . '/repository/lib.php');
class repository_filesharing extends repository {
    public function supported_returntypes() {
        return FILE_EXTERNAL;
    }
    public function default_returntype() {
        return FILE_EXTERNAL;
    }
    public function supported_filetypes() {
        return '*';
    }
    public function check_login() {
        return isloggedin() && !isguestuser() && has_capability('local/filesharing:access', context_system::instance());
    }
    public function get_listing($path = '', $page = '') {
        return $this->listing((string)$path, max(0, (int)$page), '');
    }
    public function search($search_text, $page = 0) {
        return $this->listing('', max(0, (int)$page), (string)$search_text);
    }
    protected function listing(string $path, int $page, string $search): array {
        global $OUTPUT;
        $folder = $path ?: 'root';
        if ($folder !== 'root' && !preg_match('/^[0-9a-f-]{36}$/D', $folder)) {
            throw new invalid_parameter_exception('Invalid folder.');
        }
        $query = ['q' => substr($search, 0, 200), 'page' => $page + 1, 'limit' => 50];
        if (!$search) {
            $query['folderId'] = $folder;
        }
        $resources = \local_filesharing\bridge::catalogue('list', $query);
        $folders = $search ? ['items' => []] : \local_filesharing\bridge::catalogue('folders', ['parentId' => $folder]);
        $list = [];
        foreach ($folders['items'] as $item) {
            $list[] = ['title' => $item['name'], 'path' => $item['id'], 'children' => [],
                'thumbnail' => $OUTPUT->image_url('f/folder')->out(false)];
        }
        foreach ($resources['items'] as $item) {
            if ($item['availability'] !== 'ready') {
                continue;
            }
            $list[] = ['title' => $item['name'], 'source' => $item['id'], 'size' => (int)$item['sizeBytes'],
                'datemodified' => strtotime($item['updatedAt']), 'thumbnail' => $OUTPUT->image_url('f/unknown')->out(false)];
        }
        return ['list' => $list, 'path' => [['name' => get_string('root', 'local_filesharing'), 'path' => '']],
            'dynload' => true, 'nosearch' => false, 'norefresh' => false, 'page' => $page, 'perpage' => 50,
            'total' => $resources['total'], 'pages' => max(1, (int)ceil($resources['total'] / 50)), 'issearchresult' => (bool)$search];
    }
    public function get_link($url) {
        if (!preg_match('/^[0-9a-f-]{36}$/D', (string)$url)) {
            throw new invalid_parameter_exception('Invalid resource.');
        }
        $result = \local_filesharing\bridge::catalogue('link', [], $url);
        if ($result['url'] !== \local_filesharing\bridge::app_origin() . '/download/' . $url) {
            throw new moodle_exception('apifailed', 'local_filesharing');
        }
        return $result['url'];
    }
    public function get_file($url, $filename = '') {
        throw new moodle_exception('externalonly', 'local_filesharing');
    }
}
