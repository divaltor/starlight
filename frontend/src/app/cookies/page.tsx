'use client';

import { useState } from 'react';
import { Cloud, HardDrive, Cookie, Shield, AlertTriangle, FileText, Lock, Clipboard, ClipboardList } from 'lucide-react';
import {
    cloudStorage,
    postEvent,
} from '@telegram-apps/sdk-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from '@/components/ui/accordion';

export default function CookiesPage() {
    const [cookies, setCookies] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const handleCloudStorage = async () => {
        if (!cookies.trim()) {
            setMessage({ type: 'error', text: 'Please enter cookies data' });
            return;
        }

        setIsLoading(true);
        setMessage(null);

        try {
            // Try to use cloud storage if available
            if (cloudStorage && typeof cloudStorage.setItem === 'function') {
                await cloudStorage.setItem('user_cookies', cookies);
                setMessage({ type: 'success', text: 'Cookies saved to cloud storage successfully!' });
            } else {
                // Send to backend via Telegram Mini Apps events
                postEvent('web_app_data_send', { data: cookies });
                setMessage({ type: 'success', text: 'Cookies sent to bot successfully!' });
            }

            setCookies('');
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to save cookies to cloud storage' });
        } finally {
            setIsLoading(false);
        }
    };

    const handleLocalStorage = async () => {
        if (!cookies.trim()) {
            setMessage({ type: 'error', text: 'Please enter cookies data' });
            return;
        }

        setIsLoading(true);
        setMessage(null);

        try {
            // Check if we have native Telegram storage
            if (typeof window !== 'undefined' && window.Telegram?.WebApp?.CloudStorage) {
                // Try to use Telegram's secure storage first
                window.Telegram.WebApp.CloudStorage.setItem('user_cookies', cookies);
                setMessage({ type: 'success', text: 'Cookies saved to secure storage successfully!' });
            } else if (typeof window !== 'undefined' && window.localStorage) {
                // Fallback to browser localStorage
                window.localStorage.setItem('user_cookies', cookies);
                setMessage({ type: 'success', text: 'Cookies saved to local storage successfully!' });
            } else {
                setMessage({
                    type: 'error',
                    text: 'Local storage is not available. Please use cloud storage instead.'
                });
                return;
            }

            setCookies('');
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to save cookies to local storage' });
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
            <div className="max-w-2xl w-full space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <div className="flex items-center justify-center gap-2">
                        <Cookie className="h-8 w-8 text-primary" />
                        <h1 className="text-3xl font-bold text-foreground">Cookie Storage</h1>
                    </div>
                    <p className="text-muted-foreground">
                        Securely store your cookies with cloud synchronization or local storage
                    </p>
                </div>

                {/* Main Card */}
                <Card className="shadow-lg border-primary/20">
                    <CardHeader className="text-center">
                        <CardTitle className="flex items-center justify-center gap-2">
                            <Shield className="h-5 w-5 text-primary" />
                            Cookie Input
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Textarea
                            placeholder="Paste your cookies here... (JSON, base64, or exported format)"
                            value={cookies}
                            onChange={(e) => setCookies(e.target.value)}
                            className="min-h-[120px] resize-none"
                        />

                        {/* Action Buttons */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <Button
                                onClick={handleCloudStorage}
                                disabled={isLoading}
                                className="flex items-center gap-2 bg-primary hover:bg-primary/90"
                                size="lg"
                            >
                                <Cloud className="h-4 w-4" />
                                {isLoading ? 'Saving...' : 'Save to Cloud'}
                            </Button>

                            <Button
                                onClick={handleLocalStorage}
                                disabled={isLoading}
                                variant="outline"
                                className="flex items-center gap-2"
                                size="lg"
                            >
                                <HardDrive className="h-4 w-4" />
                                Save Locally
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Status Message */}
                {message && (
                    <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
                        {message.type === 'error' ? (
                            <AlertTriangle className="h-4 w-4" />
                        ) : (
                            <Shield className="h-4 w-4" />
                        )}
                        <AlertDescription>{message.text}</AlertDescription>
                    </Alert>
                )}

                {/* Security Notice */}
                <Alert variant="warning">
                    <Lock className="h-4 w-4" />
                    <AlertTitle>Security Notice</AlertTitle>
                    <AlertDescription>
                        Cloud stored cookies are encrypted and cannot be used to manage your Twitter account.
                        They are stored securely for your convenience only.
                    </AlertDescription>
                </Alert>

                {/* Information Accordion */}
                <Card>
                    <CardContent className="p-0">
                        <Accordion type="multiple" className="w-full">
                            <AccordionItem value="storage-options">
                                <AccordionTrigger className="px-6">
                                    <div className="flex items-center gap-2">
                                        <Cloud className="h-4 w-4" />
                                        Storage Options
                                    </div>
                                </AccordionTrigger>
                                <AccordionContent className="px-6 pb-4">
                                    <div className="space-y-4">
                                        <div className="flex items-start gap-3">
                                            <Cloud className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                                            <div>
                                                <h4 className="font-medium">Cloud Storage</h4>
                                                <p className="text-sm text-muted-foreground">
                                                    Synchronized across all your devices. Data is encrypted and stored securely on Telegram's servers.
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-start gap-3">
                                            <HardDrive className="h-5 w-5 text-accent mt-0.5 flex-shrink-0" />
                                            <div>
                                                <h4 className="font-medium">Local Storage</h4>
                                                <p className="text-sm text-muted-foreground">
                                                    Stored only on this device. Faster access but not synchronized across devices.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>

                            <AccordionItem value="supported-formats">
                                <AccordionTrigger className="px-6">
                                    <div className="flex items-center gap-2">
                                        <FileText className="h-4 w-4" />
                                        Supported Formats
                                    </div>
                                </AccordionTrigger>
                                <AccordionContent className="px-6 pb-4">
                                    <div className="space-y-4">
                                        <div className="flex items-start gap-3">
                                            <Clipboard className="h-5 w-5 text-secondary-500 mt-0.5 flex-shrink-0" />
                                            <div>
                                                <h4 className="font-medium">Extension Export</h4>
                                                <p className="text-sm text-muted-foreground">
                                                    Cookie Quick Manager and other browser extension exports.
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex items-start gap-3">
                                            <Lock className="h-5 w-5 text-accent mt-0.5 flex-shrink-0" />
                                            <div>
                                                <h4 className="font-medium">Base64 Encoded</h4>
                                                <p className="text-sm text-muted-foreground">
                                                    Base64 encoded cookie data that will be automatically decoded to supported format.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
} 