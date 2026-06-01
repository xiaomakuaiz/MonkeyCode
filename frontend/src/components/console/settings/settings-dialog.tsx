"use client"

import * as React from "react"
import {
  Bell,
  Bot,
  Blocks,
  Box,
  HardDrive,
  MonitorCloud,
  Settings,
} from "lucide-react"
import { IconPasswordFingerprint } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { AlertDialogAction, AlertDialogCancel, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogContent, AlertDialog } from "@/components/ui/alert-dialog"
import { useNavigate } from "react-router-dom"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { useGitHubSetupCallback } from "@/hooks/useGitHubSetupCallback"
import { useCommonData } from "@/components/console/data-provider"
import { IS_MOBILE_PROFILE } from "@/utils/app-profile"

import Images from "./images"
import Models from "./models"
import Hosts from "./hosts"
import Identities from "./identities"
import VmsPage from "./vms"
import Notifications from "./notifications"
import ToolsAndMcp from "./tools-mcp"

const FULL_SETTINGS_NAV = [
  { id: "account", name: "账户", icon: Settings },
  { id: "identities", name: "Git 身份", icon: IconPasswordFingerprint },
  { id: "tools-mcp", name: "MCP 与工具", icon: Blocks },
  { id: "models", name: "AI 大模型", icon: Bot },
  { id: "images", name: "系统镜像", icon: Box },
  { id: "hosts", name: "宿主机", icon: HardDrive },
  { id: "vms", name: "开发环境", icon: MonitorCloud },
  { id: "notifications", name: "通知", icon: Bell },
] as const

const MOBILE_SETTINGS_NAV = [
  { id: "account", name: "账户", icon: Settings },
  { id: "notifications", name: "通知", icon: Bell },
] as const

const SETTINGS_NAV = IS_MOBILE_PROFILE ? MOBILE_SETTINGS_NAV : FULL_SETTINGS_NAV

type SettingsSectionId = (typeof SETTINGS_NAV)[number]["id"]

function AccountSettings() {
  const navigate = useNavigate()
  const { user } = useCommonData()
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border p-4">
        <div className="text-sm font-medium">账户信息</div>
        <div className="space-y-2 text-sm text-muted-foreground">
          <div>昵称：{user?.name || "未设置"}</div>
          <div>邮箱：{user?.email || "未绑定"}</div>
          <div>团队：{user?.team?.name || "个人空间"}</div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="text-sm font-medium">账户安全</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate("/findpassword")}>
            找回密码
          </Button>
          <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteDialogOpen(true)}>
            删除账户
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          删除账户后，您的账号数据将按平台规则处理。您可以先查看删除说明，再通过官方渠道提交删除申请。
        </p>
      </section>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账户</AlertDialogTitle>
            <AlertDialogDescription>
              您可以在 App 内查看隐私政策中的删除说明与联系方式，再通过官方渠道发起删除账户申请。平台会根据账号安全和数据规则处理您的请求。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
            <AlertDialogAction onClick={() => navigate("/privacy-policy#rights") }>
              查看删除说明
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SettingsContent({ section }: { section: SettingsSectionId }) {
  switch (section) {
    case "account":
      return <AccountSettings />
    case "identities":
      return <Identities />
    case "tools-mcp":
      return <ToolsAndMcp />
    case "models":
      return <Models />
    case "images":
      return <Images />
    case "hosts":
      return <Hosts />
    case "vms":
      return <VmsPage />
    case "notifications":
      return <Notifications />
    default:
      return <Identities />
  }
}

function SettingsNavContent({
  activeSection,
  onSectionChange,
}: {
  activeSection: SettingsSectionId
  onSectionChange: (id: SettingsSectionId) => void
}) {
  return (
    <Sidebar collapsible="none" className="w-12 shrink-0 border-r md:w-44">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-2 pb-4 font-semibold text-md">
          <Settings className="size-4 shrink-0" />
          <span className="hidden sm:inline">设置</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {SETTINGS_NAV.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={activeSection === item.id}
                    onClick={() => onSectionChange(item.id)}
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="hidden sm:inline">{item.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}

export interface SettingsDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeSection, setActiveSection] =
    React.useState<SettingsSectionId>(IS_MOBILE_PROFILE ? "account" : "identities")
  const { reloadIdentities } = useCommonData()

  const { result, dismiss } = useGitHubSetupCallback(() => {
    reloadIdentities()
  })

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex h-[60vh] max-h-[90vh] w-[90vw] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>配置</DialogTitle>
            <DialogDescription>自定义您的配置选项</DialogDescription>
          </DialogHeader>
          <SidebarProvider
            style={
              {
                "--sidebar-width": "14rem",
              } as React.CSSProperties
            }
            className="flex min-h-0 flex-1 overflow-hidden"
          >
            <div className="flex min-h-0 w-full flex-1 overflow-hidden">
              <SettingsNavContent
                activeSection={activeSection}
                onSectionChange={setActiveSection}
              />
              <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
                  <SettingsContent section={activeSection} />
                </div>
              </main>
            </div>
          </SidebarProvider>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={result !== null}
        onOpenChange={(open) => {
          if (!open) dismiss()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {result?.type === "success"
                ? "GitHub App 安装成功"
                : "GitHub App 安装失败"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {result?.type === "success"
                ? result.accountLogin
                  ? `已关联到账户 ${result.accountLogin}`
                  : "GitHub App 已成功安装"
                : `安装失败 (${result?.reason}): ${result?.message}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={dismiss}>确定</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
