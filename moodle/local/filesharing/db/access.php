<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
$capabilities = [];
foreach (['viewicon', 'access', 'upload', 'manageothers', 'admin'] as $name) {
    $capabilities['local/filesharing:' . $name] = [
        'captype' => in_array($name, ['viewicon', 'access']) ? 'read' : 'write',
        'contextlevel' => CONTEXT_SYSTEM,
        'archetypes' => ['manager' => CAP_ALLOW],
        'riskbitmask' => in_array($name, ['manageothers', 'admin']) ? RISK_DATALOSS | RISK_PERSONAL : 0,
    ];
}
