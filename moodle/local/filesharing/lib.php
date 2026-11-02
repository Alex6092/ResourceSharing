<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
function local_filesharing_render_navbar_output(\renderer_base $renderer): string {
    if (during_initial_install() || !isloggedin() || isguestuser()) {
        return '';
    }
    $context = context_system::instance();
    if (!has_capability('local/filesharing:viewicon', $context) || !has_capability('local/filesharing:access', $context)) {
        return '';
    }
    try {
        $origin = \local_filesharing\bridge::app_origin();
    } catch (\Throwable $e) {
        return '';
    }
    $label = get_string('openresources', 'local_filesharing');
    return html_writer::div(html_writer::link(new moodle_url($origin . '/auth/moodle/start', ['purpose' => 'manage']),
        $renderer->pix_icon('i/folder', ''), ['class' => 'nav-link', 'title' => $label, 'aria-label' => $label,
            'target' => '_blank', 'rel' => 'noopener']), 'd-flex align-items-center');
}
