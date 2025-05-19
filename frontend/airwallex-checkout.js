import { createElement, init } from '@airwallex/components-sdk';

let selectedSessionDetails = {
    amount: 0,
    currency: 'USD',
    description: ''
};

// Function to determine the API base URL
function getApiBaseUrl() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return 'http://localhost:3001'; // Local backend URL
    }
    return ''; // Relative paths for deployed environment
}

document.addEventListener('DOMContentLoaded', () => {
    const viewConsultationOptionsButton = document.getElementById('viewConsultationOptionsButton');
    const sessionChoiceContainer = document.getElementById('sessionChoiceContainer');
    const sessionOptionButtons = document.querySelectorAll('.session-option-button');
    
    const paymentLinkContainer = document.getElementById('paymentLinkContainer');
    const paymentLinkMessage = document.getElementById('paymentLinkMessage');
    const paymentChoiceContainer = document.getElementById('paymentChoiceContainer');
    const payWithLinkButton = document.getElementById('payWithLinkButton');
    const payWithDropInButton = document.getElementById('payWithDropInButton');
    const dropInContainer = document.getElementById('drop-in-container');

    function resetPaymentUI() {
        if (paymentLinkMessage) paymentLinkMessage.style.display = 'none';
        if (paymentLinkContainer) paymentLinkContainer.innerHTML = '';
        if (dropInContainer) dropInContainer.innerHTML = '';
        if (dropInContainer) dropInContainer.style.display = 'none';
        if (sessionChoiceContainer) sessionChoiceContainer.style.display = 'none';
        if (paymentChoiceContainer) paymentChoiceContainer.style.display = 'none';
        if (viewConsultationOptionsButton) viewConsultationOptionsButton.style.display = 'block';
        if (viewConsultationOptionsButton) viewConsultationOptionsButton.disabled = false;
        
        sessionOptionButtons.forEach(btn => btn.disabled = false);
        if (payWithLinkButton) payWithLinkButton.disabled = false;
        if (payWithLinkButton) payWithLinkButton.style.display = 'block';
        if (payWithDropInButton) payWithDropInButton.disabled = false;
        if (payWithDropInButton) payWithDropInButton.style.display = 'block';
    }

    if (viewConsultationOptionsButton && sessionChoiceContainer && sessionOptionButtons.length > 0 && paymentChoiceContainer && payWithLinkButton && payWithDropInButton && paymentLinkContainer && paymentLinkMessage && dropInContainer) {
        
        viewConsultationOptionsButton.addEventListener('click', () => {
            resetPaymentUI(); 
            viewConsultationOptionsButton.style.display = 'none';
            sessionChoiceContainer.style.display = 'block';
            paymentLinkMessage.textContent = 'Please select a consultation type.';
            paymentLinkMessage.className = 'text-sm text-gray-600 mt-2 text-center';
            paymentLinkMessage.style.display = 'block';
        });

        sessionOptionButtons.forEach(button => {
            button.addEventListener('click', () => {
                selectedSessionDetails.amount = parseFloat(button.dataset.amount);
                selectedSessionDetails.currency = button.dataset.currency;
                selectedSessionDetails.description = button.dataset.description;

                sessionChoiceContainer.style.display = 'none';
                paymentChoiceContainer.style.display = 'block';
                paymentLinkMessage.textContent = `Selected: ${selectedSessionDetails.description}. Choose payment method.`;
                paymentLinkMessage.className = 'text-sm text-gray-700 mt-2 text-center'; // Neutral color
            });
        });

        payWithLinkButton.addEventListener('click', async () => {
            if (!selectedSessionDetails.amount || !selectedSessionDetails.description) {
                paymentLinkMessage.textContent = 'Please select a session type first.';
                paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
                return;
            }
            paymentLinkMessage.textContent = 'Generating payment link...';
            paymentLinkMessage.style.display = 'block';
            paymentLinkContainer.innerHTML = '';
            dropInContainer.style.display = 'none'; 
            payWithLinkButton.disabled = true;
            payWithDropInButton.style.display = 'none';

            const apiBaseUrl = getApiBaseUrl();
            const fetchUrl = `${apiBaseUrl}/api/airwallex/create-payment-link`;
            try {
                const response = await fetch(fetchUrl, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(selectedSessionDetails)
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    throw new Error(errorData.details?.message || errorData.details?.error || errorData.error || `HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                if (data.payment_link_url) {
                    const link = document.createElement('a');
                    link.href = data.payment_link_url;
                    link.textContent = `Pay for ${selectedSessionDetails.description} (Opens in new tab)`;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    link.className = 'text-blue-600 hover:text-blue-800 underline font-semibold';
                    paymentLinkContainer.appendChild(link);
                    paymentLinkMessage.textContent = 'Payment link generated! Click above.';
                    paymentLinkMessage.className = 'text-sm text-green-600 mt-2 text-center';
                } else {
                    throw new Error('Payment link URL not found in response.');
                }
            } catch (error) {
                console.error('Error creating payment link:', error);
                paymentLinkMessage.textContent = `Error: ${error.message}`;
                paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
            } finally {
                payWithLinkButton.disabled = false; 
                paymentChoiceContainer.style.display = 'block'; 
                payWithDropInButton.style.display = 'block'; 
            }
        });

        payWithDropInButton.addEventListener('click', () => {
            if (!selectedSessionDetails.amount || !selectedSessionDetails.description) {
                paymentLinkMessage.textContent = 'Please select a session type first.';
                paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
                return;
            }
            paymentLinkMessage.textContent = 'Loading payment options...';
            paymentLinkMessage.style.display = 'block';
            paymentLinkContainer.innerHTML = '';
            dropInContainer.style.display = 'block';
            payWithDropInButton.disabled = true;
            payWithLinkButton.style.display = 'none';
            initializeDropInElement();
        });

    } else {
        console.error('One or more Airwallex checkout UI elements are missing from the DOM. Check IDs: viewConsultationOptionsButton, sessionChoiceContainer, .session-option-button, paymentChoiceContainer, etc.');
    }
});

async function initializeDropInElement() {
    const dropInContainer = document.getElementById('drop-in-container');
    const paymentLinkMessage = document.getElementById('paymentLinkMessage');

    if (!selectedSessionDetails.amount || !selectedSessionDetails.description) {
         paymentLinkMessage.textContent = 'Error: Session details not selected before initializing Drop-in.';
         paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
         if (dropInContainer) dropInContainer.innerHTML = '<p class="text-sm text-red-500 mt-2">Session details missing.</p>';
         document.getElementById('payWithDropInButton').disabled = false;
         document.getElementById('payWithLinkButton').style.display = 'block';
         return;
    }

    try {
        console.log('Initializing Airwallex SDK for Drop-in...');
        await init({
            env: 'demo',
            locale: 'en',
            enabledElements: ['payments']
        });
        console.log('Airwallex SDK initialized for Drop-in.');

        const apiBaseUrl = getApiBaseUrl();
        const intentResponse = await fetch(`${apiBaseUrl}/api/airwallex/create-payment-intent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(selectedSessionDetails)
        });

        if (!intentResponse.ok) {
            const errorData = await intentResponse.json().catch(() => ({}));
            throw new Error(`Payment intent creation failed: ${errorData.details?.message || errorData.details?.error || errorData.error || intentResponse.statusText}`);
        }
        const intentDetails = await intentResponse.json();

        if (!intentDetails.intent_id || !intentDetails.client_secret || !intentDetails.currency) {
            throw new Error('Essential Payment Intent details missing from backend response.');
        }

        const dropInElement = await createElement('dropIn', {
            intent_id: intentDetails.intent_id,
            client_secret: intentDetails.client_secret,
            currency: intentDetails.currency,
        });

        if (dropInElement) {
            dropInContainer.innerHTML = ''; 
            dropInElement.mount('drop-in-container');
            paymentLinkMessage.textContent = `Complete payment for: ${selectedSessionDetails.description}.`;
            paymentLinkMessage.className = 'text-sm text-gray-700 mt-2 text-center';

            dropInElement.on('ready', (event) => {
                console.log('Drop-in UI is ready:', event.detail);
                paymentLinkMessage.textContent = `Payment form ready for ${selectedSessionDetails.description}.`;
            });

            dropInElement.on('success', (event) => {
                console.log('Drop-in Success Event:', event.detail);
                if (event.detail.intent && event.detail.intent.status === 'SUCCEEDED') {
                    paymentLinkMessage.textContent = `Payment for ${selectedSessionDetails.description} successful! Thank you.`;
                    paymentLinkMessage.className = 'text-sm text-green-600 mt-2 text-center';
                    dropInContainer.innerHTML = '<p class="text-center text-green-600 py-4">Payment Confirmed!</p>';
                    setTimeout(() => { window.location.href = 'payment-success.html'; }, 2500);
                } else {
                    paymentLinkMessage.textContent = `Payment status: ${event.detail.intent?.status || 'Processing'}. Please follow instructions.`;
                    console.warn('Drop-in success event, but intent status is:', event.detail.intent?.status);
                }
            });

            dropInElement.on('error', (event) => {
                console.error('Drop-in Error Event:', event.detail.error);
                paymentLinkMessage.textContent = `Payment Error: ${event.detail.error.message || 'Unknown Drop-in error.'}`;
                paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
                document.getElementById('payWithDropInButton').disabled = false;
                document.getElementById('payWithLinkButton').style.display = 'block';
            });

        } else {
            throw new Error('Drop-in element could not be created.');
        }

    } catch (error) {
        console.error('Failed to initialize Airwallex Drop-in element:', error);
        if (paymentLinkMessage) {
            paymentLinkMessage.textContent = `Error setting up payment form: ${error.message}`;
            paymentLinkMessage.className = 'text-sm text-red-600 mt-2 text-center';
        }
        if (dropInContainer) {
            dropInContainer.innerHTML = `<p class="text-sm text-red-500 mt-2">Could not load payment form: ${error.message}</p>`;
        }
        document.getElementById('payWithDropInButton').disabled = false;
        document.getElementById('payWithLinkButton').style.display = 'block';
    }
} 