<?php
// SPDX-License-Identifier: GPL-3.0-or-later
namespace tiny_filesharing;
defined('MOODLE_INTERNAL') || die();
class plugininfo extends \editor_tiny\plugin implements \editor_tiny\plugin_with_buttons, \editor_tiny\plugin_with_menuitems {
    public static function get_available_buttons(): array {
        return ['tiny_filesharing/resources'];
    }
    public static function get_available_menuitems(): array {
        return ['tiny_filesharing/resources'];
    }
    public static function is_enabled(\context $context, array $options, array $fpoptions, ?\editor_tiny\editor $editor = null): bool {
        return isloggedin() && !isguestuser() && has_capability('local/filesharing:access', \context_system::instance());
    }
}
